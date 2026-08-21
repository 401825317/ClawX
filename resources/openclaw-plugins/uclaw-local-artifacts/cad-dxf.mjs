import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CAD_DXF_SCHEMA = 'uclaw.cad.floor-plan/v1';

export const CAD_REQUIRED_LAYERS = Object.freeze([
  'BOUNDARY',
  'WALLS',
  'DOORS',
  'WINDOWS',
  'STAIRS',
  'DIMENSIONS',
  'ANNOTATIONS',
]);

const UNIT_CODES = Object.freeze({
  unitless: 0,
  in: 1,
  ft: 2,
  mm: 4,
  cm: 5,
  m: 6,
});

const LAYER_COLORS = Object.freeze({
  BOUNDARY: 7,
  WALLS: 7,
  DOORS: 1,
  WINDOWS: 5,
  STAIRS: 3,
  DIMENSIONS: 2,
  ANNOTATIONS: 6,
});

const REQUIRED_SECTIONS = Object.freeze(['HEADER', 'TABLES', 'BLOCKS', 'ENTITIES']);
const MAX_DIMENSION = 1_000_000;

export class CadDxfError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CadDxfError';
    this.code = code;
    Object.assign(this, details);
  }
}

function isOmitted(value) {
  return value === undefined;
}

function parseFiniteNumber(value, field) {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numeric)) {
    throw new CadDxfError('cad_invalid_parameters', `${field} must be a finite number`, {
      field,
      recoverable: true,
      restartGateway: false,
      stage: 'input',
    });
  }
  return numeric;
}

function boundedNumber(input, field, fallback, minimum, maximum, assumptions, unit) {
  if (isOmitted(input)) {
    assumptions.push(`${field} defaulted to ${formatDistance(fallback, unit)}`);
    return fallback;
  }
  const numeric = parseFiniteNumber(input, field);
  if (numeric <= minimum || numeric > maximum) {
    throw new CadDxfError(
      'cad_invalid_parameters',
      `${field} must be greater than ${minimum} and no greater than ${maximum}`,
      {
        field,
        value: numeric,
        minimum,
        maximum,
        recoverable: true,
        restartGateway: false,
        stage: 'input',
      },
    );
  }
  return numeric;
}

function positiveNumber(input, field, fallback, maximum, assumptions, unit) {
  return boundedNumber(input, field, fallback, 0, maximum, assumptions, unit);
}

function integer(input, field, fallback, minimum, maximum, assumptions) {
  if (isOmitted(input)) {
    assumptions.push(`${field} defaulted to ${fallback}`);
    return fallback;
  }
  const numeric = parseFiniteNumber(input, field);
  if (!Number.isInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw new CadDxfError(
      'cad_invalid_parameters',
      `${field} must be an integer from ${minimum} to ${maximum}`,
      {
        field,
        value: numeric,
        minimum,
        maximum,
        recoverable: true,
        restartGateway: false,
        stage: 'input',
      },
    );
  }
  return numeric;
}

function dxfNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return Number(numeric.toFixed(6)).toString();
}

function cleanDxfText(value, fallback = '') {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/[\r\n]+/gu, ' ')
    .replace(/[^\x20-\x7e]/gu, (character) => (
      [...character]
        .flatMap((item) => {
          const codePoint = item.codePointAt(0);
          if (codePoint <= 0xffff) return [codePoint];
          const adjusted = codePoint - 0x10000;
          return [0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff)];
        })
        .map((codeUnit) => `\\U+${codeUnit.toString(16).toUpperCase().padStart(4, '0')}`)
        .join('')
    ))
    .trim();
  return text || fallback;
}

function pair(code, value) {
  return `${code}\n${value}\n`;
}

function entity(type, layer, values = []) {
  return pair(0, type) + pair(8, layer) + values.map(([code, value]) => pair(code, value)).join('');
}

function line(layer, x1, y1, x2, y2) {
  return entity('LINE', layer, [
    [10, dxfNumber(x1)], [20, dxfNumber(y1)], [30, 0],
    [11, dxfNumber(x2)], [21, dxfNumber(y2)], [31, 0],
  ]);
}

function polyline(layer, points, closed = true) {
  let result = entity('POLYLINE', layer, [
    [66, 1], [10, 0], [20, 0], [30, 0], [70, closed ? 1 : 0],
  ]);
  for (const point of points) {
    result += entity('VERTEX', layer, [
      [10, dxfNumber(point.x)], [20, dxfNumber(point.y)], [30, 0], [70, 0],
    ]);
  }
  return result + entity('SEQEND', layer);
}

function arc(layer, cx, cy, radius, startAngle, endAngle) {
  return entity('ARC', layer, [
    [10, dxfNumber(cx)], [20, dxfNumber(cy)], [30, 0],
    [40, dxfNumber(radius)], [50, dxfNumber(startAngle)], [51, dxfNumber(endAngle)],
  ]);
}

function text(layer, value, x, y, height, rotation = 0) {
  return entity('TEXT', layer, [
    [10, dxfNumber(x)], [20, dxfNumber(y)], [30, 0],
    [40, dxfNumber(height)], [1, cleanDxfText(value)], [50, dxfNumber(rotation)],
  ]);
}

function dimensionEntity(name, x1, y1, x2, y2, textX, textY, rotation = 0) {
  return entity('DIMENSION', 'DIMENSIONS', [
    [2, name], [10, dxfNumber(textX)], [20, dxfNumber(textY)], [30, 0],
    [11, dxfNumber(textX)], [21, dxfNumber(textY)], [31, 0],
    [70, 0], [1, '<>'], [3, 'STANDARD'], [50, dxfNumber(rotation)],
    [13, dxfNumber(x1)], [23, dxfNumber(y1)], [33, 0],
    [14, dxfNumber(x2)], [24, dxfNumber(y2)], [34, 0],
  ]);
}

function dimensionBlock(name, x1, y1, x2, y2, label, textX, textY, height) {
  return pair(0, 'BLOCK')
    + pair(8, '0') + pair(2, name) + pair(70, 1)
    + pair(10, 0) + pair(20, 0) + pair(30, 0) + pair(3, name) + pair(1, '')
    + line('DIMENSIONS', x1, y1, x2, y2)
    + text('DIMENSIONS', label, textX, textY, height)
    + pair(0, 'ENDBLK') + pair(8, '0');
}

function unitLabel(unit) {
  return unit === 'unitless' ? '' : unit;
}

function formatDistance(value, unit) {
  const rounded = Number(value.toFixed(3)).toString();
  return `${rounded}${unitLabel(unit)}`;
}

export function normalizeCadPlan(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CadDxfError('cad_invalid_parameters', 'CAD parameters must be an object', {
      recoverable: true,
      restartGateway: false,
      stage: 'input',
    });
  }
  const assumptions = [];
  let unit;
  if (isOmitted(input.unit)) {
    unit = 'm';
    assumptions.push('unit defaulted to m');
  } else if (typeof input.unit === 'string' && Object.hasOwn(UNIT_CODES, input.unit)) {
    unit = input.unit;
  } else {
    throw new CadDxfError('cad_invalid_parameters', `unit is unsupported: ${String(input.unit)}`, {
      field: 'unit',
      value: input.unit,
      allowed: Object.keys(UNIT_CODES),
      recoverable: true,
      restartGateway: false,
      stage: 'input',
    });
  }

  const defaultWidth = unit === 'mm' ? 12000 : unit === 'cm' ? 1200 : unit === 'in' ? 472 : unit === 'ft' ? 39 : 12;
  const defaultDepth = unit === 'mm' ? 15000 : unit === 'cm' ? 1500 : unit === 'in' ? 591 : unit === 'ft' ? 49 : 15;
  const width = boundedNumber(input.width, 'width', defaultWidth, 0, MAX_DIMENSION, assumptions, unit);
  const depth = boundedNumber(input.depth, 'depth', defaultDepth, 0, MAX_DIMENSION, assumptions, unit);
  const floors = integer(input.floors, 'floors', 1, 1, 12, assumptions);

  const minimumSide = Math.min(width, depth);
  const wallThickness = positiveNumber(input.wallThickness, 'wallThickness', minimumSide * 0.02, minimumSide * 0.12, assumptions, unit);
  const doorWidth = positiveNumber(input.doorWidth, 'doorWidth', minimumSide * 0.09, minimumSide * 0.25, assumptions, unit);
  const windowWidth = positiveNumber(input.windowWidth, 'windowWidth', minimumSide * 0.14, minimumSide * 0.35, assumptions, unit);
  const stairWidth = positiveNumber(input.stairWidth, 'stairWidth', minimumSide * 0.16, minimumSide * 0.35, assumptions, unit);
  if (input.includeDimensions !== undefined && typeof input.includeDimensions !== 'boolean') {
    throw new CadDxfError('cad_invalid_parameters', 'includeDimensions must be a boolean', {
      field: 'includeDimensions',
      value: input.includeDimensions,
      recoverable: true,
      restartGateway: false,
      stage: 'input',
    });
  }
  const title = cleanDxfText(input.title, 'UClaw editable floor plan');

  return {
    schema: CAD_DXF_SCHEMA,
    title,
    unit,
    unitCode: UNIT_CODES[unit],
    width,
    depth,
    floors,
    wallThickness,
    doorWidth,
    windowWidth,
    stairWidth,
    includeDimensions: input.includeDimensions !== false,
    assumptions,
  };
}

function layerTable() {
  let result = pair(0, 'TABLE') + pair(2, 'LAYER') + pair(70, CAD_REQUIRED_LAYERS.length + 1);
  result += pair(0, 'LAYER') + pair(2, '0') + pair(70, 0) + pair(62, 7) + pair(6, 'CONTINUOUS');
  for (const layer of CAD_REQUIRED_LAYERS) {
    result += pair(0, 'LAYER') + pair(2, layer) + pair(70, 0) + pair(62, LAYER_COLORS[layer]) + pair(6, 'CONTINUOUS');
  }
  return result + pair(0, 'ENDTAB');
}

function staticTables() {
  return pair(0, 'TABLE') + pair(2, 'LTYPE') + pair(70, 1)
    + pair(0, 'LTYPE') + pair(2, 'CONTINUOUS') + pair(70, 0)
    + pair(3, 'Solid line') + pair(72, 65) + pair(73, 0) + pair(40, 0)
    + pair(0, 'ENDTAB')
    + layerTable()
    + pair(0, 'TABLE') + pair(2, 'STYLE') + pair(70, 1)
    + pair(0, 'STYLE') + pair(2, 'STANDARD') + pair(70, 0) + pair(40, 0) + pair(41, 1)
    + pair(50, 0) + pair(71, 0) + pair(42, 2.5) + pair(3, 'txt') + pair(4, '')
    + pair(0, 'ENDTAB')
    + pair(0, 'TABLE') + pair(2, 'DIMSTYLE') + pair(70, 1)
    + pair(0, 'DIMSTYLE') + pair(2, 'STANDARD') + pair(70, 0)
    + pair(40, 1) + pair(41, 2.5) + pair(42, 0.625) + pair(140, 2.5)
    + pair(0, 'ENDTAB');
}

function floorGeometry(plan, floorIndex, dimensionIndex) {
  const gap = plan.width * 0.18;
  const offsetX = floorIndex * (plan.width + gap);
  const x0 = offsetX;
  const y0 = 0;
  const x1 = x0 + plan.width;
  const y1 = plan.depth;
  const inset = plan.wallThickness;
  const labelHeight = Math.max(Math.min(plan.width, plan.depth) * 0.022, inset * 0.7);
  const dimensionGap = Math.max(plan.wallThickness * 5, Math.min(plan.width, plan.depth) * 0.07);
  const entities = [];
  const blocks = [];

  entities.push(polyline('BOUNDARY', [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
  ]));
  entities.push(polyline('WALLS', [
    { x: x0 + inset, y: y0 + inset }, { x: x1 - inset, y: y0 + inset },
    { x: x1 - inset, y: y1 - inset }, { x: x0 + inset, y: y1 - inset },
  ]));

  const midX = x0 + plan.width * 0.5;
  const midY = plan.depth * 0.5;
  entities.push(line('WALLS', midX, y0 + inset, midX, y1 - inset));
  entities.push(line('WALLS', x0 + inset, midY, x1 - inset, midY));

  const frontDoorX = x0 + plan.width * 0.2;
  entities.push(line('DOORS', frontDoorX, y0 + inset, frontDoorX + plan.doorWidth, y0 + inset));
  entities.push(arc('DOORS', frontDoorX, y0 + inset, plan.doorWidth, 0, 90));
  const interiorDoorY = y0 + plan.depth * 0.7;
  entities.push(line('DOORS', midX, interiorDoorY, midX + plan.doorWidth, interiorDoorY));
  entities.push(arc('DOORS', midX, interiorDoorY, plan.doorWidth, 0, 90));

  const halfWindow = plan.windowWidth / 2;
  entities.push(line('WINDOWS', x0 + plan.width * 0.25 - halfWindow, y1 - inset, x0 + plan.width * 0.25 + halfWindow, y1 - inset));
  entities.push(line('WINDOWS', x0 + plan.width * 0.75 - halfWindow, y1 - inset, x0 + plan.width * 0.75 + halfWindow, y1 - inset));
  entities.push(line('WINDOWS', x0 + inset, plan.depth * 0.25 - halfWindow, x0 + inset, plan.depth * 0.25 + halfWindow));
  entities.push(line('WINDOWS', x1 - inset, plan.depth * 0.75 - halfWindow, x1 - inset, plan.depth * 0.75 + halfWindow));

  const stairX = x0 + plan.width * 0.62;
  const stairY = y0 + plan.depth * 0.56;
  const stairLength = Math.min(plan.depth * 0.32, plan.stairWidth * 2.4);
  entities.push(polyline('STAIRS', [
    { x: stairX, y: stairY }, { x: stairX + plan.stairWidth, y: stairY },
    { x: stairX + plan.stairWidth, y: stairY + stairLength }, { x: stairX, y: stairY + stairLength },
  ]));
  for (let tread = 1; tread < 8; tread += 1) {
    const y = stairY + stairLength * tread / 8;
    entities.push(line('STAIRS', stairX, y, stairX + plan.stairWidth, y));
  }

  entities.push(text('ANNOTATIONS', `${plan.title} - Floor ${floorIndex + 1}`, x0 + inset * 2, y1 + labelHeight * 1.8, labelHeight));
  entities.push(text('ANNOTATIONS', 'Room A', x0 + plan.width * 0.22, plan.depth * 0.25, labelHeight));
  entities.push(text('ANNOTATIONS', 'Room B', x0 + plan.width * 0.68, plan.depth * 0.25, labelHeight));
  entities.push(text('ANNOTATIONS', 'Room C', x0 + plan.width * 0.22, plan.depth * 0.75, labelHeight));
  entities.push(text('ANNOTATIONS', 'Stairs', stairX, stairY + stairLength * 0.5, labelHeight));

  if (plan.includeDimensions) {
    const widthName = `*D${dimensionIndex}`;
    const widthY = y0 - dimensionGap;
    const widthTextX = x0 + plan.width * 0.5;
    const widthTextY = widthY + labelHeight * 0.5;
    blocks.push(dimensionBlock(
      widthName, x0, widthY, x1, widthY, formatDistance(plan.width, plan.unit), widthTextX, widthTextY, labelHeight,
    ));
    entities.push(dimensionEntity(widthName, x0, y0, x1, y0, widthTextX, widthY));

    const depthName = `*D${dimensionIndex + 1}`;
    const depthX = x0 - dimensionGap;
    const depthTextX = depthX - labelHeight * 0.5;
    const depthTextY = y0 + plan.depth * 0.5;
    blocks.push(dimensionBlock(
      depthName, depthX, y0, depthX, y1, formatDistance(plan.depth, plan.unit), depthTextX, depthTextY, labelHeight,
    ));
    entities.push(dimensionEntity(depthName, x0, y0, x0, y1, depthX, depthTextY, 90));
  }

  return { entities, blocks };
}

export function createDxfContent(input = {}) {
  const plan = normalizeCadPlan(input);
  const entities = [];
  const blocks = [];
  for (let floorIndex = 0; floorIndex < plan.floors; floorIndex += 1) {
    const floor = floorGeometry(plan, floorIndex, floorIndex * 2 + 1);
    entities.push(...floor.entities);
    blocks.push(...floor.blocks);
  }

  const header = pair(0, 'SECTION') + pair(2, 'HEADER')
    + pair(9, '$ACADVER') + pair(1, 'AC1009')
    + pair(9, '$DWGCODEPAGE') + pair(3, 'ANSI_1252')
    + pair(9, '$INSUNITS') + pair(70, plan.unitCode)
    + pair(0, 'ENDSEC');
  const tables = pair(0, 'SECTION') + pair(2, 'TABLES') + staticTables() + pair(0, 'ENDSEC');
  const blockSection = pair(0, 'SECTION') + pair(2, 'BLOCKS') + blocks.join('') + pair(0, 'ENDSEC');
  const entitySection = pair(0, 'SECTION') + pair(2, 'ENTITIES') + entities.join('') + pair(0, 'ENDSEC');
  return { plan, content: `${header}${tables}${blockSection}${entitySection}${pair(0, 'EOF')}` };
}

function parsePairs(content) {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const pairs = [];
  const issues = [];
  if (lines.length % 2 !== 0) issues.push('DXF group-code/value pairs are incomplete');
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const codeText = lines[index].trim();
    if (!/^-?\d+$/u.test(codeText)) {
      issues.push(`invalid DXF group code: ${codeText || '<empty>'}`);
      continue;
    }
    const code = Number(codeText);
    pairs.push({ code, value: lines[index + 1].trim() });
  }
  return { pairs, issues };
}

function valuesFor(entityRecord, code) {
  return entityRecord.pairs.filter((item) => item.code === code).map((item) => item.value);
}

function parseDxfNumber(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function numericValue(entityRecord, code, index = 0) {
  return parseDxfNumber(valuesFor(entityRecord, code)[index]);
}

function numericValues(entityRecord, code) {
  return valuesFor(entityRecord, code).map(parseDxfNumber).filter((value) => value !== null);
}

function entityPoints(entityRecord) {
  if (entityRecord.type === 'LINE') {
    const x1 = numericValue(entityRecord, 10);
    const y1 = numericValue(entityRecord, 20);
    const x2 = numericValue(entityRecord, 11);
    const y2 = numericValue(entityRecord, 21);
    return [x1, y1, x2, y2].every((value) => value !== null)
      ? [{ x: x1, y: y1 }, { x: x2, y: y2 }]
      : [];
  }
  if (entityRecord.type === 'POLYLINE') {
    return (entityRecord.vertices ?? []).map((vertex) => {
      const x = numericValue(vertex, 10);
      const y = numericValue(vertex, 20);
      return x !== null && y !== null ? { x, y } : null;
    }).filter(Boolean);
  }
  if (entityRecord.type === 'ARC' || entityRecord.type === 'TEXT') {
    const x = numericValue(entityRecord, 10);
    const y = numericValue(entityRecord, 20);
    return x !== null && y !== null ? [{ x, y }] : [];
  }
  if (entityRecord.type === 'DIMENSION') {
    const x1 = numericValue(entityRecord, 13);
    const y1 = numericValue(entityRecord, 23);
    const x2 = numericValue(entityRecord, 14);
    const y2 = numericValue(entityRecord, 24);
    return [x1, y1, x2, y2].every((value) => value !== null)
      ? [{ x: x1, y: y1 }, { x: x2, y: y2 }]
      : [];
  }
  return [];
}

function entityValidationIssue(entityRecord) {
  const layer = valuesFor(entityRecord, 8)[0];
  if (!layer) return `${entityRecord.type} entity is missing its layer`;
  switch (entityRecord.type) {
    case 'LINE':
      if (entityPoints(entityRecord).length !== 2) return 'LINE entity has invalid endpoints';
      if (Math.hypot(
        entityPoints(entityRecord)[1].x - entityPoints(entityRecord)[0].x,
        entityPoints(entityRecord)[1].y - entityPoints(entityRecord)[0].y,
      ) <= 1e-9) return 'LINE entity has zero length';
      break;
    case 'POLYLINE': {
      const points = entityPoints(entityRecord);
      const follows = parseDxfNumber(valuesFor(entityRecord, 66)[0]);
      const closed = parseDxfNumber(valuesFor(entityRecord, 70)[0]);
      if (points.length < 2 || points.length !== entityRecord.vertices?.length || follows !== 1) {
        return 'POLYLINE entity has invalid vertices';
      }
      if (closed !== 0 && closed !== 1) return 'POLYLINE entity has an invalid closed flag';
      break;
    }
    case 'ARC': {
      const points = entityPoints(entityRecord);
      const radius = numericValue(entityRecord, 40);
      const startAngle = numericValue(entityRecord, 50);
      const endAngle = numericValue(entityRecord, 51);
      if (points.length !== 1 || radius === null || radius <= 0 || startAngle === null || endAngle === null) {
        return 'ARC entity has invalid geometry';
      }
      break;
    }
    case 'TEXT': {
      const height = numericValue(entityRecord, 40);
      const value = valuesFor(entityRecord, 1)[0];
      if (entityPoints(entityRecord).length !== 1 || height === null || height <= 0 || !value) {
        return 'TEXT entity has invalid content or geometry';
      }
      break;
    }
    case 'DIMENSION':
      if (entityPoints(entityRecord).length !== 2 || !valuesFor(entityRecord, 2)[0]) {
        return 'DIMENSION entity has invalid definition points';
      }
      break;
    default:
      break;
  }
  return null;
}

function pointInsideBoundary(point, boundary) {
  const tolerance = Math.max(1e-6, Math.max(boundary.width, boundary.depth) * 0.001);
  return point.x >= boundary.minX - tolerance
    && point.x <= boundary.maxX + tolerance
    && point.y >= boundary.minY - tolerance
    && point.y <= boundary.maxY + tolerance;
}

function entityFitsOneBoundary(entityRecord, boundaries) {
  const points = entityPoints(entityRecord);
  return points.length > 0 && boundaries.some((boundary) => points.every((point) => pointInsideBoundary(point, boundary)));
}

function isRectangleBoundary(boundary) {
  if (boundary.vertexCount !== 4 || !boundary.closed || boundary.points.length !== 4) return false;
  const expected = new Set([
    `${boundary.minX}:${boundary.minY}`,
    `${boundary.maxX}:${boundary.minY}`,
    `${boundary.maxX}:${boundary.maxY}`,
    `${boundary.minX}:${boundary.maxY}`,
  ]);
  return new Set(boundary.points.map((point) => `${point.x}:${point.y}`)).size === 4
    && boundary.points.every((point) => expected.has(`${point.x}:${point.y}`));
}

function dimensionMatchesBoundary(record, boundary) {
  const horizontal = approximatelyEqual(record.y1, boundary.minY)
    && approximatelyEqual(record.y2, boundary.minY)
    && approximatelyEqual(record.x1, boundary.minX)
    && approximatelyEqual(record.x2, boundary.maxX);
  const vertical = approximatelyEqual(record.x1, boundary.minX)
    && approximatelyEqual(record.x2, boundary.minX)
    && approximatelyEqual(record.y1, boundary.minY)
    && approximatelyEqual(record.y2, boundary.maxY);
  return horizontal || vertical;
}

function inspectDxfStructure(pairs) {
  const issues = [];
  const sectionCounts = {};
  let activeSection = '';
  let eofCount = 0;
  let eofIsTerminal = false;

  for (let index = 0; index < pairs.length; index += 1) {
    const item = pairs[index];
    const next = pairs[index + 1];
    if (item.code === 0 && item.value === 'SECTION') {
      if (activeSection) issues.push(`DXF section ${activeSection} is not closed`);
      if (next?.code !== 2 || !next.value) {
        issues.push('DXF SECTION is missing its name');
        continue;
      }
      activeSection = next.value;
      sectionCounts[activeSection] = (sectionCounts[activeSection] ?? 0) + 1;
      index += 1;
      continue;
    }
    if (item.code === 0 && item.value === 'ENDSEC') {
      if (!activeSection) issues.push('DXF ENDSEC appears outside a section');
      activeSection = '';
      continue;
    }
    if (item.code === 0 && item.value === 'EOF') {
      eofCount += 1;
      if (activeSection) issues.push(`DXF EOF appears before ${activeSection} is closed`);
      eofIsTerminal = index === pairs.length - 1;
    }
  }
  if (activeSection) issues.push(`DXF section ${activeSection} is not closed`);
  if (eofCount !== 1) issues.push(`DXF EOF marker count is invalid (${eofCount})`);
  if (eofCount === 1 && !eofIsTerminal) issues.push('DXF EOF marker must be the final group pair');

  return { issues, sectionCounts, eofCount, eofIsTerminal };
}

export function inspectDxfContent(content) {
  if (typeof content !== 'string' || content.includes('\u0000')) {
    return {
      pairCount: 0,
      sectionCount: 0,
      sectionNames: [],
      hasEof: false,
      layers: [],
      blockNames: [],
      entities: [],
      entityCount: 0,
      byType: {},
      byLayer: {},
      boundaries: [],
      dimensions: [],
      dimensionRecords: [],
      insUnits: null,
      parseIssues: ['DXF content is not valid text'],
    };
  }
  const parsed = parsePairs(content);
  const { pairs } = parsed;
  const structure = inspectDxfStructure(pairs);
  const layers = new Set();
  const blockNames = new Set();
  const sectionNames = new Set();
  const rawEntities = [];
  let insUnits = null;
  let section = '';
  let blockOpen = false;
  let current = null;

  const finishEntity = () => {
    if (current) rawEntities.push(current);
    current = null;
  };

  for (let index = 0; index < pairs.length; index += 1) {
    const item = pairs[index];
    const next = pairs[index + 1];
    if (item.code === 0 && item.value === 'SECTION' && next?.code === 2) {
      finishEntity();
      section = next.value;
      sectionNames.add(section);
      index += 1;
      continue;
    }
    if (item.code === 0 && item.value === 'ENDSEC') {
      finishEntity();
      section = '';
      continue;
    }
    if (section === 'HEADER' && item.code === 9 && item.value === '$INSUNITS' && next?.code === 70) {
      const value = parseDxfNumber(next.value);
      insUnits = Number.isInteger(value) ? value : null;
    }
    if (section === 'TABLES' && item.code === 0 && item.value === 'LAYER') {
      if (next?.code === 2) layers.add(next.value);
      continue;
    }
    if (section === 'BLOCKS') {
      if (item.code === 0 && item.value === 'BLOCK') blockOpen = true;
      else if (blockOpen && item.code === 2) {
        blockNames.add(item.value);
        blockOpen = false;
      } else if (item.code === 0 && item.value === 'ENDBLK') {
        blockOpen = false;
      }
    }
    if (section !== 'ENTITIES') continue;
    if (item.code === 0) {
      finishEntity();
      current = { type: item.value, pairs: [] };
      continue;
    }
    current?.pairs.push(item);
  }
  finishEntity();

  const entities = [];
  const entitySequenceIssues = [];
  for (let index = 0; index < rawEntities.length; index += 1) {
    const item = rawEntities[index];
    if (item.type === 'POLYLINE') {
      const vertices = [];
      let cursor = index + 1;
      while (rawEntities[cursor]?.type === 'VERTEX') {
        vertices.push(rawEntities[cursor]);
        cursor += 1;
      }
      if (rawEntities[cursor]?.type !== 'SEQEND') {
        entitySequenceIssues.push('POLYLINE entity is missing SEQEND');
      } else {
        index = cursor;
      }
      entities.push({ ...item, vertices });
      continue;
    }
    if (item.type === 'VERTEX' || item.type === 'SEQEND') {
      entitySequenceIssues.push(`${item.type} appears outside a POLYLINE entity`);
      continue;
    }
    entities.push(item);
  }

  const byType = {};
  const byLayer = {};
  const boundaries = [];
  const dimensions = [];
  const dimensionRecords = [];
  for (const item of entities) {
    byType[item.type] = (byType[item.type] ?? 0) + 1;
    const layer = valuesFor(item, 8)[0] || '0';
    byLayer[layer] = (byLayer[layer] ?? 0) + 1;
    if (item.type === 'POLYLINE' && layer === 'BOUNDARY') {
      const points = entityPoints(item);
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      if (points.length > 0) {
        boundaries.push({
          minX: Math.min(...xs), maxX: Math.max(...xs),
          minY: Math.min(...ys), maxY: Math.max(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          depth: Math.max(...ys) - Math.min(...ys),
          vertexCount: Math.min(xs.length, ys.length),
          closed: Number(valuesFor(item, 70)[0]) === 1,
          points,
        });
      }
    }
    if (item.type === 'DIMENSION') {
      const x1 = numericValue(item, 13);
      const y1 = numericValue(item, 23);
      const x2 = numericValue(item, 14);
      const y2 = numericValue(item, 24);
      if ([x1, y1, x2, y2].every((value) => value !== null)) {
        const length = Math.hypot(x2 - x1, y2 - y1);
        dimensions.push(length);
        dimensionRecords.push({ length, x1, y1, x2, y2, layer });
      }
    }
  }

  return {
    pairCount: pairs.length,
    sectionCount: pairs.filter((item) => item.code === 0 && item.value === 'SECTION').length,
    sectionNames: [...sectionNames].sort(),
    hasEof: structure.eofCount === 1 && structure.eofIsTerminal,
    layers: [...layers].sort(),
    blockNames: [...blockNames].sort(),
    entities,
    entityCount: entities.length,
    byType,
    byLayer,
    boundaries,
    dimensions,
    dimensionRecords,
    insUnits,
    parseIssues: [...parsed.issues, ...structure.issues, ...entitySequenceIssues],
    sectionCounts: structure.sectionCounts,
    eofCount: structure.eofCount,
    eofIsTerminal: structure.eofIsTerminal,
  };
}

function approximatelyEqual(actual, expected) {
  return Math.abs(actual - expected) <= Math.max(1e-6, Math.abs(expected) * 0.001);
}

export function validateDxfContent(content, expectedInput = {}) {
  let expected;
  try {
    expected = normalizeCadPlan(expectedInput);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 'blocked',
      kind: 'cad.structure',
      engine: 'uclaw-dxf-js/v1',
      required: true,
      issues: [detail],
      evidence: {
        schema: CAD_DXF_SCHEMA,
        editableFormat: 'DXF',
      },
    };
  }
  const inspection = inspectDxfContent(content);
  const issues = [];
  issues.push(...inspection.parseIssues);
  if (!inspection.eofCount) issues.push('DXF EOF marker is missing');
  if (inspection.eofCount === 1 && !inspection.eofIsTerminal) issues.push('DXF EOF marker must be the final group pair');
  if (inspection.sectionCount < REQUIRED_SECTIONS.length) {
    issues.push(`DXF sections are incomplete (${inspection.sectionCount}/${REQUIRED_SECTIONS.length})`);
  }
  for (const section of REQUIRED_SECTIONS) {
    if (!inspection.sectionNames.includes(section)) issues.push(`required DXF section is missing: ${section}`);
    if ((inspection.sectionCounts?.[section] ?? 0) !== 1) {
      issues.push(`required DXF section count is invalid: ${section}`);
    }
  }
  const expectedUnitCode = expected.unitCode ?? UNIT_CODES[expected.unit];
  if (!Number.isInteger(expectedUnitCode) || inspection.insUnits !== expectedUnitCode) {
    issues.push(`DXF $INSUNITS does not match ${expected.unit ?? 'the requested unit'}`);
  }
  for (const entityRecord of inspection.entities) {
    const entityIssue = entityValidationIssue(entityRecord);
    if (entityIssue) issues.push(`${entityRecord.type}: ${entityIssue}`);
  }
  if (inspection.entityCount < expected.floors * 20) {
    issues.push(`DXF entity count is too small (${inspection.entityCount})`);
  }
  for (const layer of CAD_REQUIRED_LAYERS) {
    if (!inspection.layers.includes(layer)) issues.push(`required layer is missing: ${layer}`);
    if ((layer !== 'DIMENSIONS' || expected.includeDimensions) && (inspection.byLayer[layer] ?? 0) < 1) {
      issues.push(`required layer has no entity: ${layer}`);
    }
  }
  const requiredEntityTypes = ['LINE', 'POLYLINE', 'ARC', 'TEXT'];
  if (expected.includeDimensions) requiredEntityTypes.push('DIMENSION');
  for (const type of requiredEntityTypes) {
    if ((inspection.byType[type] ?? 0) < 1) issues.push(`required entity type is missing: ${type}`);
  }
  if (inspection.boundaries.length !== expected.floors) {
    issues.push(`floor boundary count mismatch (${inspection.boundaries.length}/${expected.floors})`);
  }
  const uniqueBoundaries = new Set();
  for (const [index, boundary] of inspection.boundaries.entries()) {
    if (!approximatelyEqual(boundary.width, expected.width) || !approximatelyEqual(boundary.depth, expected.depth)) {
      issues.push(`floor ${index + 1} boundary mismatch (${boundary.width}x${boundary.depth}, expected ${expected.width}x${expected.depth})`);
    }
    if (!isRectangleBoundary(boundary)) issues.push(`floor ${index + 1} boundary is not a closed rectangle`);
    const boundaryKey = [boundary.minX, boundary.minY, boundary.maxX, boundary.maxY].join(':');
    if (uniqueBoundaries.has(boundaryKey)) issues.push(`floor ${index + 1} boundary duplicates another floor`);
    uniqueBoundaries.add(boundaryKey);
  }
  if (expected.includeDimensions) {
    const widthDimensions = inspection.dimensions.filter((value) => approximatelyEqual(value, expected.width)).length;
    const depthDimensions = inspection.dimensions.filter((value) => approximatelyEqual(value, expected.depth)).length;
    if (widthDimensions < expected.floors) issues.push(`width dimensions missing (${widthDimensions}/${expected.floors})`);
    if (depthDimensions < expected.floors) issues.push(`depth dimensions missing (${depthDimensions}/${expected.floors})`);
    if (inspection.dimensionRecords.length !== expected.floors * 2) {
      issues.push(`dimension entity count mismatch (${inspection.dimensionRecords.length}/${expected.floors * 2})`);
    }
    for (const record of inspection.dimensionRecords) {
      if (!inspection.boundaries.some((boundary) => dimensionMatchesBoundary(record, boundary))) {
        issues.push('DIMENSION entity does not match a floor boundary');
        break;
      }
    }
  } else if (inspection.dimensionRecords.length > 0) {
    issues.push('DIMENSION entities are present while includeDimensions is false');
  }
  const semanticMinimums = {
    WALLS: expected.floors * 3,
    DOORS: expected.floors * 4,
    WINDOWS: expected.floors * 4,
    STAIRS: expected.floors * 8,
    ANNOTATIONS: expected.floors * 4,
  };
  for (const [layer, minimum] of Object.entries(semanticMinimums)) {
    const actual = inspection.byLayer[layer] ?? 0;
    if (actual < minimum) issues.push(`${layer} coverage is incomplete (${actual}/${minimum})`);
  }

  const layerTypeCount = (layer, type) => inspection.entities.filter((item) => (
    valuesFor(item, 8)[0] === layer && item.type === type
  )).length;
  const typeMinimums = [
    ['WALLS', 'POLYLINE', expected.floors],
    ['WALLS', 'LINE', expected.floors * 2],
    ['DOORS', 'LINE', expected.floors * 2],
    ['DOORS', 'ARC', expected.floors * 2],
    ['WINDOWS', 'LINE', expected.floors * 4],
    ['STAIRS', 'POLYLINE', expected.floors],
    ['STAIRS', 'LINE', expected.floors * 7],
    ['ANNOTATIONS', 'TEXT', expected.floors * 4],
  ];
  if (expected.includeDimensions) typeMinimums.push(['DIMENSIONS', 'DIMENSION', expected.floors * 2]);
  for (const [layer, type, minimum] of typeMinimums) {
    const actual = layerTypeCount(layer, type);
    if (actual < minimum) issues.push(`${layer} ${type} coverage is incomplete (${actual}/${minimum})`);
  }
  if (expected.includeDimensions && inspection.dimensionRecords.some((record) => record.layer !== 'DIMENSIONS')) {
    issues.push('DIMENSION entity is not on the DIMENSIONS layer');
  }
  if (expected.includeDimensions) {
    for (const dimension of inspection.entities.filter((item) => item.type === 'DIMENSION')) {
      const blockName = valuesFor(dimension, 2)[0];
      if (!inspection.blockNames.includes(blockName)) {
        issues.push(`DIMENSION block is missing: ${blockName || '<empty>'}`);
      }
    }
  }

  for (const layer of ['WALLS', 'DOORS', 'WINDOWS', 'STAIRS']) {
    const layerEntities = inspection.entities.filter((item) => valuesFor(item, 8)[0] === layer);
    if (!layerEntities.every((item) => entityFitsOneBoundary(item, inspection.boundaries))) {
      issues.push(`${layer} geometry is outside every floor boundary`);
    }
  }

  return {
    ok: issues.length === 0,
    status: issues.length === 0 ? 'passed' : 'blocked',
    kind: 'cad.structure',
    engine: 'uclaw-dxf-js/v1',
    required: true,
    issues,
    evidence: {
      schema: CAD_DXF_SCHEMA,
      unit: expected.unit,
      width: expected.width,
      depth: expected.depth,
      floorCount: expected.floors,
      entityCount: inspection.entityCount,
      entityTypes: inspection.byType,
      layers: inspection.layers,
      layerEntityCounts: inspection.byLayer,
      boundaryCount: inspection.boundaries.length,
      dimensionCount: inspection.dimensions.length,
      insUnits: inspection.insUnits,
      pythonRuntime: 'not-required',
      editableFormat: 'DXF',
    },
  };
}

export async function writeValidatedDxf(filePath, input = {}) {
  if (typeof filePath !== 'string' || !filePath.trim() || path.extname(filePath).toLowerCase() !== '.dxf') {
    throw new CadDxfError('cad_invalid_output_path', 'CAD output path must end with .dxf', {
      filePath,
      recoverable: true,
      restartGateway: false,
      stage: 'output_path',
    });
  }

  const { plan, content } = createDxfContent(input);
  const preflight = validateDxfContent(content, plan);
  if (!preflight.ok) {
    throw new CadDxfError('cad_structure_verification_failed', `DXF generation blocked: ${preflight.issues.join('; ')}`, {
      verification: preflight,
      recoverable: true,
      restartGateway: false,
      stage: 'preflight',
    });
  }

  let temporaryPath;
  let published = false;
  try {
    try {
      await lstat(filePath);
      throw new CadDxfError('cad_output_exists', 'CAD output path already exists', {
        filePath,
        recoverable: true,
        restartGateway: false,
        stage: 'output_path',
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    const readBack = await readFile(temporaryPath, 'utf8');
    const verification = validateDxfContent(readBack, plan);
    if (!verification.ok) {
      throw new CadDxfError('cad_readback_verification_failed', `DXF read-back verification failed: ${verification.issues.join('; ')}`, {
        filePath,
        verification,
        recoverable: true,
        restartGateway: false,
        stage: 'readback',
      });
    }
    try {
      await copyFile(temporaryPath, filePath, fsConstants.COPYFILE_EXCL);
      published = true;
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new CadDxfError('cad_output_exists', 'CAD output path already exists', {
          filePath,
          recoverable: true,
          restartGateway: false,
          stage: 'output_path',
        });
      }
      throw error;
    }
    const publishedContent = await readFile(filePath, 'utf8');
    const publishedVerification = validateDxfContent(publishedContent, plan);
    if (!publishedVerification.ok) {
      throw new CadDxfError('cad_readback_verification_failed', `Published DXF verification failed: ${publishedVerification.issues.join('; ')}`, {
        filePath,
        verification: publishedVerification,
        recoverable: true,
        restartGateway: false,
        stage: 'publish',
      });
    }
    published = false;
    return { plan, verification: publishedVerification };
  } catch (error) {
    if (published) await unlink(filePath).catch(() => undefined);
    if (error instanceof CadDxfError) throw error;
    throw new CadDxfError('cad_output_write_failed', `DXF output could not be written: ${error instanceof Error ? error.message : String(error)}`, {
      filePath,
      recoverable: true,
      restartGateway: false,
      stage: 'write',
      cause: error,
    });
  } finally {
    if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
  }
}
