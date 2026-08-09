import { describe, expect, it } from 'vitest';
import { validateSceneSpec } from '@electron/services/blender/scene-spec-validator';

const minimalScene = {
  schema: 'uclaw.blender.scene/v1',
  title: '安全场景',
  objects: [
    { id: 'hero', primitive: 'cube' },
  ],
};

describe('Blender SceneSpec validator', () => {
  it('accepts the fixed declarative schema', () => {
    const result = validateSceneSpec(minimalScene);

    expect(result.ok).toBe(true);
    expect(result.normalized?.schema).toBe('uclaw.blender.scene/v1');
    expect(result.normalized?.objects).toHaveLength(1);
  });

  it.each([
    ['python', 'import bpy'],
    ['shell', 'rm -rf /'],
    ['script', 'bpy.ops.mesh.primitive_cube_add()'],
  ])('rejects executable top-level field %s', (field, value) => {
    const result = validateSceneSpec({
      ...minimalScene,
      [field]: value,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`scene.${field} is not allowed in SceneSpec`);
  });

  it('rejects executable or unknown object fields', () => {
    const result = validateSceneSpec({
      ...minimalScene,
      objects: [{
        id: 'hero',
        primitive: 'cube',
        command: 'python payload.py',
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('objects[0].command is not allowed in SceneSpec');
  });

  it('rejects executable fields nested in declarative sections', () => {
    const result = validateSceneSpec({
      ...minimalScene,
      project: { fps: 24, shell: 'powershell.exe' },
      world: { strength: 1, script: 'payload.py' },
      render: { width: 512, command: 'blender --python payload.py' },
      deliverables: { glb: true, exec: true },
      budgets: { maxObjects: 10, python: 'import bpy' },
      objects: [{
        id: 'hero',
        primitive: 'cube',
        transform: { location: [0, 0, 0], shell: 'cmd.exe' },
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'project.shell is not allowed in SceneSpec',
      'world.script is not allowed in SceneSpec',
      'render.command is not allowed in SceneSpec',
      'deliverables.exec is not allowed in SceneSpec',
      'budgets.python is not allowed in SceneSpec',
      'objects[0].transform.shell is not allowed in SceneSpec',
    ]));
  });
});
