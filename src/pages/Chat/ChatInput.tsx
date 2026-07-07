/**
 * Chat Input Component
 * Textarea with send button and universal file upload support.
 * Enter to send, Shift+Enter for new line.
 * Supports: native file picker, clipboard paste, drag & drop.
 * Files are staged to disk via IPC — only lightweight path references
 * are sent with the message (no base64 over WebSocket).
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { SendHorizontal, Square, X, Paperclip, FileText, Film, Music, FileArchive, File, FolderOpen, Loader2, AtSign, Search, ChevronDown, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { useChatStore } from '@/stores/chat';
import { useArtifactPanel } from '@/stores/artifact-panel';
import { buildPreviewTarget } from '@/components/file-preview/build-preview-target';
import { useProviderStore } from '@/stores/providers';
import { DEFAULT_CLIENT_MODEL_OPTIONS, useClientConfigStore } from '@/stores/client-config';
import {
  formatModelDisplayLabel,
  formatProviderModelIdLabel,
  toModelOptionTestId,
} from '@/lib/model-options';
import type { AgentSummary } from '@/types/agent';
import type { QuickAccessSkill } from '@/types/skill';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { rendererExtensionRegistry } from '@/extensions/registry';
import { collectDroppedFiles } from '@/lib/collect-dropped-files';
import type { ChatImageSendOptions, ChatSendMode, ChatVideoSendOptions } from '@/stores/chat/types';
import { Select } from '@/components/ui/select';

// ── Types ────────────────────────────────────────────────────────

export interface FileAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;        // disk path for gateway
  preview: string | null;    // data URL for images, null for others
  status: 'staging' | 'ready' | 'error';
  error?: string;
}

interface ChatInputProps {
  onSend: (
    text: string,
    attachments?: FileAttachment[],
    targetAgentId?: string | null,
    mode?: ChatSendMode,
    imageOptions?: ChatImageSendOptions,
    videoOptions?: ChatVideoSendOptions,
  ) => void;
  onStop?: () => void;
  disabled?: boolean;
  sending?: boolean;
  imageEditReference?: ImageEditReference | null;
  onClearImageEditReference?: () => void;
}

interface RemoteModelOption {
  modelRef: string;
  label: string;
  runtimeProviderKey: string;
  accountId: string;
}

export interface ImageEditReference {
  fileName: string;
  mimeType: string;
  fileSize: number;
  filePath: string;
  preview: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────

const DIRECTORY_MIME_TYPE = 'application/x-directory';
const DEFAULT_TEXT_MODEL_OPTION: RemoteModelOption = {
  modelRef: `lingzhiwuxian/${DEFAULT_CLIENT_MODEL_OPTIONS.text.defaultModel}`,
  label: formatProviderModelIdLabel('lingzhiwuxian', DEFAULT_CLIENT_MODEL_OPTIONS.text.defaultModel),
  runtimeProviderKey: 'lingzhiwuxian',
  accountId: 'lingzhiwuxian',
};
const IMAGE_EDIT_SUPPORTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IMAGE_EDIT_SUPPORTED_EXTENSIONS = /\.(jpe?g|jfif|png|webp)$/i;
const KNOWN_IMAGE_EXTENSIONS = /\.(avif|bmp|gif|heic|heif|jfif|jpe?g|png|svg|tiff?|webp)$/i;

type ImageEditReferenceCandidate = {
  fileName?: string;
  name?: string;
  mimeType?: string;
  type?: string;
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function normalizeMimeType(mimeType: string | undefined): string {
  return String(mimeType || '').split(';')[0].trim().toLowerCase();
}

function fileNameOf(candidate: ImageEditReferenceCandidate): string {
  return candidate.fileName || candidate.name || 'image';
}

function isGenericMimeType(mimeType: string): boolean {
  return !mimeType || mimeType === 'application/octet-stream' || mimeType === 'binary/octet-stream';
}

function isUnsupportedImageEditReference(candidate: ImageEditReferenceCandidate): boolean {
  const mimeType = normalizeMimeType(candidate.mimeType || candidate.type);
  const fileName = fileNameOf(candidate);
  if (IMAGE_EDIT_SUPPORTED_MIME_TYPES.has(mimeType) || IMAGE_EDIT_SUPPORTED_EXTENSIONS.test(fileName)) {
    return false;
  }
  if (mimeType.startsWith('image/')) return true;
  return isGenericMimeType(mimeType) && KNOWN_IMAGE_EXTENSIONS.test(fileName);
}

function showUnsupportedImageEditReferenceToast(
  candidates: ImageEditReferenceCandidate[],
  t: ReturnType<typeof useTranslation>['t'],
): void {
  const unsupported = candidates.filter(isUnsupportedImageEditReference);
  if (unsupported.length === 0) return;

  const names = unsupported.slice(0, 3).map((candidate) => {
    const mimeType = normalizeMimeType(candidate.mimeType || candidate.type);
    return `${fileNameOf(candidate)}${mimeType ? ` (${mimeType})` : ''}`;
  });
  const files = unsupported.length > 3
    ? `${names.join(', ')} +${unsupported.length - 3}`
    : names.join(', ');
  toast.warning(t('composer.unsupportedImageEditReferenceFormat', {
    files,
    defaultValue: `这些图片可以作为普通附件上传，但不能作为 OpenAI 图片编辑参考图：${files}。请先转成 PNG、JPEG 或 WebP 后再图生图。`,
  }), { duration: 8000 });
}

function getSkillPrefix(skillName: string): string {
  return `/${skillName}  `;
}

function formatImageSizeLabel(value: string): string {
  switch (value) {
    case '1024x1024':
      return '1K';
    case '2048x2048':
      return '2K';
    case '3840x2160':
      return '4K';
    default:
      return value;
  }
}

function formatVideoSizeLabel(value: string): string {
  switch (value) {
    case '1280x720':
      return '16:9';
    case '720x1280':
      return '9:16';
    case '1024x1024':
      return '1:1';
    default:
      return value;
  }
}

function formatImageQualityLabel(value: string, t: ReturnType<typeof useTranslation>['t']): string {
  switch (value) {
    case 'low':
      return t('composer.imageQualityLow', 'Low');
    case 'medium':
      return t('composer.imageQualityMedium', 'Medium');
    case 'high':
      return t('composer.imageQualityHigh', 'High');
    default:
      return value;
  }
}

function needsLeadingSkillSpace(value: string, position: number): boolean {
  return position > 0 && !/\s/.test(value[position - 1] ?? '');
}

type SkillTokenRange = { start: number; end: number };

function findSkillTokenRange(value: string, skillName: string): SkillTokenRange | null {
  const token = getSkillPrefix(skillName);
  const start = value.indexOf(token);
  if (start === -1) return null;
  return { start, end: start + token.length };
}

function findSkillTokenRanges(value: string): SkillTokenRange[] {
  const ranges: SkillTokenRange[] = [];
  const skillTokenPattern = /\/[^\s]+ {2}/g;
  let match: RegExpExecArray | null;
  while ((match = skillTokenPattern.exec(value)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function removeSkillToken(value: string, skillName: string): string {
  const range = findSkillTokenRange(value, skillName);
  if (!range) return value;
  return `${value.slice(0, range.start)}${value.slice(range.end)}`;
}

const SKILL_TOKEN_BUTTON_CLASS =
  'rounded-md bg-skill-bg/14 text-skill-fg [-webkit-box-decoration-break:clone] [box-decoration-break:clone] [text-shadow:0_0_10px_rgba(47,107,255,0.38)] dark:bg-skill-bg/18 dark:text-skill-fg-dark dark:[text-shadow:0_0_12px_rgba(37,99,235,0.42)]';

function renderHighlightedComposerText(
  value: string,
  tokenRanges: SkillTokenRange[],
  options: { onPreviewSkill: (skillName: string) => void; previewTooltip: string },
) {
  if (tokenRanges.length === 0) {
    return <>{value}{value.endsWith('\n') ? '\n' : '\u200b'}</>;
  }

  const chunks: React.ReactNode[] = [];
  let cursor = 0;

  for (const tokenRange of tokenRanges) {
    const token = value.slice(tokenRange.start, tokenRange.end);
    const tokenLabel = token.trimEnd();
    const tokenTrailingSpace = token.slice(tokenLabel.length);
    const skillName = tokenLabel.startsWith('/') ? tokenLabel.slice(1) : tokenLabel;

    if (tokenRange.start > cursor) {
      chunks.push(value.slice(cursor, tokenRange.start));
    }
    chunks.push(
      <button
        key={`skill-token-${tokenRange.start}`}
        type="button"
        data-testid="chat-composer-skill-token"
        data-skill-name={skillName}
        title={options.previewTooltip}
        className={cn(
          'inline h-auto border-0 p-0 font-inherit leading-inherit',
          'pointer-events-auto cursor-pointer underline-offset-2 hover:underline',
          'text-left align-baseline shadow-none transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-0',
          SKILL_TOKEN_BUTTON_CLASS,
        )}
        onMouseDown={(event) => {
          // Keep focus in the textarea while still receiving the click.
          event.preventDefault();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          options.onPreviewSkill(skillName);
        }}
      >
        {tokenLabel}
      </button>,
      tokenTrailingSpace,
    );
    cursor = tokenRange.end;
  }

  if (cursor < value.length) {
    chunks.push(value.slice(cursor));
  }
  chunks.push(value.endsWith('\n') ? '\n' : '\u200b');

  return <>{chunks}</>;
}

function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType === DIRECTORY_MIME_TYPE) return <FolderOpen className={className} />;
  if (mimeType.startsWith('video/')) return <Film className={className} />;
  if (mimeType.startsWith('audio/')) return <Music className={className} />;
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return <FileText className={className} />;
  if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('archive') || mimeType.includes('tar') || mimeType.includes('rar') || mimeType.includes('7z')) return <FileArchive className={className} />;
  if (mimeType === 'application/pdf') return <FileText className={className} />;
  return <File className={className} />;
}

/**
 * Read a browser File object as base64 string (without the data URL prefix).
 */
function readFileAsBase64(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      if (!dataUrl || !dataUrl.includes(',')) {
        reject(new Error(`Invalid data URL from FileReader for ${file.name}`));
        return;
      }
      const base64 = dataUrl.split(',')[1];
      if (!base64) {
        reject(new Error(`Empty base64 data for ${file.name}`));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// ── Component ────────────────────────────────────────────────────

export function ChatInput({
  onSend,
  onStop,
  disabled = false,
  sending = false,
  imageEditReference = null,
  onClearImageEditReference,
}: ChatInputProps) {
  const { t } = useTranslation('chat');
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState('');
  const [quickSkills, setQuickSkills] = useState<QuickAccessSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<QuickAccessSkill | null>(null);
  const [optimisticModelRef, setOptimisticModelRef] = useState<string | null>(null);
  const [remoteModelOptions, setRemoteModelOptions] = useState<RemoteModelOption[]>([]);
  const [sessionSendModes, setSessionSendModes] = useState<Record<string, ChatSendMode>>({});
  const [sessionImageOptions, setSessionImageOptions] = useState<Record<string, ChatImageSendOptions>>({});
  const [sessionVideoOptions, setSessionVideoOptions] = useState<Record<string, ChatVideoSendOptions>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const skillPickerRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelChangeVersionRef = useRef(0);
  const isComposingRef = useRef(false);
  const gatewayStatus = useGatewayStore((s) => s.status);
  const agents = useAgentsStore((s) => s.agents);
  const defaultModelRef = useAgentsStore((s) => s.defaultModelRef);
  const providerAccounts = useProviderStore((s) => s.accounts);
  const refreshProviderSnapshot = useProviderStore((s) => s.refreshProviderSnapshot);
  const clientModelOptions = useClientConfigStore((s) => s.modelOptions);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessions = useChatStore((s) => s.sessions);
  const updateSessionModel = useChatStore((s) => s.updateSessionModel);
  const currentAgent = useMemo(
    () => (agents ?? []).find((agent) => agent.id === currentAgentId) ?? null,
    [agents, currentAgentId],
  );
  const currentSession = useMemo(
    () => (sessions ?? []).find((session) => session.key === currentSessionKey) ?? null,
    [currentSessionKey, sessions],
  );
  const sendMode = sessionSendModes[currentSessionKey] ?? 'chat';
  const hasImageEditReference = !!imageEditReference?.filePath;
  const imageModelOptions = clientModelOptions.image.models;
  const selectedImageModel = useMemo(() => {
    return imageModelOptions.find((model) => model.id === clientModelOptions.image.defaultModel)
      ?? imageModelOptions[0];
  }, [clientModelOptions.image.defaultModel, imageModelOptions]);
  const defaultImageOptions = useMemo<ChatImageSendOptions>(() => ({
    model: selectedImageModel?.id ?? clientModelOptions.image.defaultModel,
    size: selectedImageModel?.defaultSize ?? clientModelOptions.image.defaultSize,
    quality: selectedImageModel?.defaultQuality ?? clientModelOptions.image.defaultQuality,
  }), [
    clientModelOptions.image.defaultModel,
    clientModelOptions.image.defaultQuality,
    clientModelOptions.image.defaultSize,
    selectedImageModel,
  ]);
  const imageOptions = useMemo<ChatImageSendOptions>(() => {
    const current = sessionImageOptions[currentSessionKey] ?? defaultImageOptions;
    const model = selectedImageModel;
    const size = model?.sizes.includes(current.size) ? current.size : defaultImageOptions.size;
    const quality = model?.qualities.includes(current.quality) ? current.quality : defaultImageOptions.quality;
    return {
      model: model?.id ?? current.model ?? defaultImageOptions.model,
      size,
      quality,
    };
  }, [currentSessionKey, defaultImageOptions, selectedImageModel, sessionImageOptions]);

  useEffect(() => {
    if (!hasImageEditReference) return;
    setSessionSendModes((current) => {
      if (current[currentSessionKey] === 'image') return current;
      return { ...current, [currentSessionKey]: 'image' };
    });
    textareaRef.current?.focus();
  }, [currentSessionKey, hasImageEditReference]);
  const videoModelOptions = clientModelOptions.video.models;
  const selectedVideoModel = useMemo(() => {
    return videoModelOptions.find((model) => model.id === clientModelOptions.video.defaultModel)
      ?? videoModelOptions[0];
  }, [clientModelOptions.video.defaultModel, videoModelOptions]);
  const defaultVideoOptions = useMemo<ChatVideoSendOptions>(() => ({
    size: selectedVideoModel?.defaultSize ?? clientModelOptions.video.defaultSize,
    durationSeconds: selectedVideoModel?.defaultDurationSeconds ?? clientModelOptions.video.defaultDurationSeconds,
  }), [
    clientModelOptions.video.defaultDurationSeconds,
    clientModelOptions.video.defaultSize,
    selectedVideoModel,
  ]);
  const videoOptions = useMemo<ChatVideoSendOptions>(() => {
    const current = sessionVideoOptions[currentSessionKey] ?? defaultVideoOptions;
    const model = selectedVideoModel;
    const size = model?.sizes.includes(current.size) ? current.size : defaultVideoOptions.size;
    const durationSeconds = model?.durations.includes(current.durationSeconds)
      ? current.durationSeconds
      : defaultVideoOptions.durationSeconds;
    return {
      size,
      durationSeconds,
    };
  }, [currentSessionKey, defaultVideoOptions, selectedVideoModel, sessionVideoOptions]);
  const currentAgentName = useMemo(
    () => currentAgent?.name ?? currentAgentId,
    [currentAgent, currentAgentId],
  );
  const configuredTextModelOptions = useMemo<RemoteModelOption[]>(() => {
    const textModels = clientModelOptions.text.models.length > 0
      ? clientModelOptions.text.models
      : [{
        id: DEFAULT_CLIENT_MODEL_OPTIONS.text.defaultModel,
        label: DEFAULT_TEXT_MODEL_OPTION.label,
        enabled: true,
      }];
    return textModels.map((model) => ({
      modelRef: `lingzhiwuxian/${model.id}`,
      label: model.label || formatProviderModelIdLabel('lingzhiwuxian', model.id),
      runtimeProviderKey: 'lingzhiwuxian',
      accountId: 'lingzhiwuxian',
    }));
  }, [clientModelOptions.text.models]);
  const modelOptions = useMemo(() => {
    const preferredRemoteOptions = configuredTextModelOptions.length > 0
      ? configuredTextModelOptions
      : remoteModelOptions;
    const deduped = new Map<string, RemoteModelOption>();
    for (const option of preferredRemoteOptions) {
      deduped.set(option.modelRef, option);
    }
    if (deduped.size === 0) {
      deduped.set(DEFAULT_TEXT_MODEL_OPTION.modelRef, DEFAULT_TEXT_MODEL_OPTION);
    }
    return [...deduped.values()];
  }, [configuredTextModelOptions, remoteModelOptions]);
  const requestedModelRef = optimisticModelRef || currentSession?.model || currentAgent?.modelRef || defaultModelRef || null;
  const effectiveModelRef = requestedModelRef && modelOptions.some((option) => option.modelRef === requestedModelRef)
    ? requestedModelRef
    : modelOptions[0]?.modelRef || null;
  const currentModelLabel = modelOptions.find((option) => option.modelRef === effectiveModelRef)?.label
    ?? formatModelDisplayLabel(effectiveModelRef);
  const mentionableAgents = useMemo(
    () => (agents ?? []).filter((agent) => agent.id !== currentAgentId),
    [agents, currentAgentId],
  );
  const selectedTarget = useMemo(
    () => (agents ?? []).find((agent) => agent.id === targetAgentId) ?? null,
    [agents, targetAgentId],
  );
  const filteredQuickSkills = useMemo(() => {
    const query = skillQuery.trim().toLowerCase();
    if (!query) return quickSkills;
    return quickSkills.filter((skill) =>
      skill.name.toLowerCase().includes(query)
      || skill.description.toLowerCase().includes(query)
      || skill.sourceLabel.toLowerCase().includes(query),
    );
  }, [quickSkills, skillQuery]);
  const showAgentPicker = mentionableAgents.length > 0;
  const showModelPicker = true;
  const chatComposerStatusComponents = rendererExtensionRegistry.getChatComposerStatusComponents();
  const isGatewayUsable = gatewayStatus.state === 'running' && gatewayStatus.gatewayReady !== false;
  const inputDisabled = disabled || !isGatewayUsable;
  const skillTokenRanges = useMemo(() => findSkillTokenRanges(input), [input]);
  const openArtifactPreview = useArtifactPanel((s) => s.openPreview);

  useEffect(() => {
    void refreshProviderSnapshot({ quiet: true });
  }, [refreshProviderSnapshot]);

  useEffect(() => {
    if (gatewayStatus.state === 'running') return;
    let cancelled = false;
    invokeIpc('gateway:status')
      .then((status: unknown) => {
        if (cancelled) return;
        const latest = status as { state?: string };
        if (latest?.state === 'running') {
          void refreshProviderSnapshot({ quiet: true });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [gatewayStatus.state, refreshProviderSnapshot]);

  useEffect(() => {
    setOptimisticModelRef(null);
  }, [currentSession?.model, currentSessionKey]);

  useEffect(() => {
    let cancelled = false;
    const safeProviderAccounts = Array.isArray(providerAccounts) ? providerAccounts : [];
    const junfeiaiAccount = safeProviderAccounts.find((account) => account.id === 'lingzhiwuxian' && account.enabled);
    if (!junfeiaiAccount || clientModelOptions.text.models.length > 0) {
      setRemoteModelOptions([]);
      return () => {
        cancelled = true;
      };
    }

    void hostApiFetch<{ models?: string[] }>('/api/junfeiai/models')
      .then((payload) => {
        if (cancelled) return;
        const next = Array.isArray(payload?.models)
          ? Array.from(new Set(
            payload.models
              .map((model) => (typeof model === 'string' ? model.trim() : ''))
              .filter(Boolean),
          )).map((modelId) => ({
            modelRef: `lingzhiwuxian/${modelId}`,
            label: formatProviderModelIdLabel('lingzhiwuxian', modelId),
            runtimeProviderKey: 'lingzhiwuxian',
            accountId: 'lingzhiwuxian',
          }))
          : [];
        setRemoteModelOptions(next);
      })
      .catch(() => {
        if (!cancelled) {
          setRemoteModelOptions([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [clientModelOptions.text.models.length, providerAccounts]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 240)}px`;
    }
  }, [input]);

  // Focus textarea on mount (avoids Windows focus loss after session delete + native dialog)
  useEffect(() => {
    if (!inputDisabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [inputDisabled]);

  useEffect(() => {
    if (!targetAgentId) return;
    if (targetAgentId === currentAgentId) {
      setTargetAgentId(null);
      setPickerOpen(false);
      return;
    }
    if (!(agents ?? []).some((agent) => agent.id === targetAgentId)) {
      setTargetAgentId(null);
      setPickerOpen(false);
    }
  }, [agents, currentAgentId, targetAgentId]);

  useEffect(() => {
    if (!pickerOpen && !skillPickerOpen && !modelPickerOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideAgentPicker = pickerRef.current?.contains(target);
      const insideSkillPicker = skillPickerRef.current?.contains(target);
      const insideModelPicker = modelPickerRef.current?.contains(target);
      if (!insideAgentPicker && !insideSkillPicker && !insideModelPicker) {
        setPickerOpen(false);
        setSkillPickerOpen(false);
        setModelPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [modelPickerOpen, pickerOpen, skillPickerOpen]);

  useEffect(() => {
    setSelectedSkill((prev) => {
      if (prev) {
        setInput((currentInput) => removeSkillToken(currentInput, prev.name));
      }
      return null;
    });
    setSkillPickerOpen(false);
    setSkillQuery('');
    setQuickSkills([]);
    setSkillsError(null);
  }, [currentAgentId]);

  useEffect(() => {
    if (!selectedSkill) return;
    const tokenRange = findSkillTokenRange(input, selectedSkill.name);
    if (!tokenRange) {
      setSelectedSkill(null);
    }
  }, [input, selectedSkill]);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
  }, []);

  const moveCaretTo = useCallback((position: number) => {
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(position, position);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(position, position);
    });
  }, []);

  const normalizeSelectionAroundSkill = useCallback(() => {
    if (skillTokenRanges.length === 0) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const selectionStart = textarea.selectionStart ?? 0;
    const selectionEnd = textarea.selectionEnd ?? 0;
    if (selectionStart !== selectionEnd) return;
    const tokenRange = skillTokenRanges.find((range) => selectionStart > range.start && selectionStart < range.end);
    if (tokenRange) {
      moveCaretTo(tokenRange.end);
    }
  }, [moveCaretTo, skillTokenRanges]);

  const loadQuickSkills = useCallback(async (): Promise<QuickAccessSkill[]> => {
    if (!currentAgent) {
      setQuickSkills([]);
      setSkillsError(null);
      return [];
    }
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const result = await hostApiFetch<{
        success: boolean;
        skills?: QuickAccessSkill[];
        error?: string;
      }>('/api/skills/quick-access', {
        method: 'POST',
        body: JSON.stringify({
          workspace: currentAgent.workspace,
          agentDir: currentAgent.agentDir,
        }),
      });
      if (!result.success) {
        throw new Error(result.error || 'Failed to load skills');
      }
      const list = result.skills || [];
      setQuickSkills(list);
      return list;
    } catch (error) {
      setQuickSkills([]);
      setSkillsError(String(error));
      return [];
    } finally {
      setSkillsLoading(false);
    }
  }, [currentAgent]);

  const handleSkillTokenPreview = useCallback(async (skillName: string) => {
    let list = quickSkills;
    if (list.length === 0 && currentAgent) {
      list = await loadQuickSkills();
    }
    const skill = list.find((entry) => entry.name === skillName);
    if (!skill) {
      toast.error(
        t('composer.skillPreviewNotFound', 'Could not find this skill. Open the skill picker to refresh the list.'),
      );
      return;
    }
    openArtifactPreview(buildPreviewTarget(skill.manifestPath));
  }, [quickSkills, currentAgent, loadQuickSkills, openArtifactPreview, t]);

  useEffect(() => {
    if (!skillPickerOpen) return;
    void loadQuickSkills();
  }, [skillPickerOpen, loadQuickSkills]);

  const handleSelectModel = useCallback(async (modelRef: string) => {
    if (modelRef === effectiveModelRef && requestedModelRef === effectiveModelRef) {
      setModelPickerOpen(false);
      textareaRef.current?.focus();
      return;
    }

    const previousModelRef = effectiveModelRef;
    const desiredOverride = modelRef === (defaultModelRef || '').trim() ? null : modelRef;
    const changeVersion = modelChangeVersionRef.current + 1;
    modelChangeVersionRef.current = changeVersion;
    setOptimisticModelRef(modelRef);
    setModelPickerOpen(false);
    textareaRef.current?.focus();

    void (async () => {
      try {
        await updateSessionModel(currentSessionKey, desiredOverride);
      } catch (error) {
        if (modelChangeVersionRef.current === changeVersion) {
          setOptimisticModelRef(previousModelRef);
        }
        toast.error(t('composer.modelSwitchFailed', { error: String(error) }));
        console.error('Failed to switch session model:', error);
      }
    })();
  }, [currentSessionKey, defaultModelRef, effectiveModelRef, requestedModelRef, t, updateSessionModel]);

  // ── File staging via native dialog / Electron drag-drop paths ──

  const stagePathFiles = useCallback(async (filePaths: string[]) => {
    if (filePaths.length === 0) return;

    const tempIds: string[] = [];
    for (const filePath of filePaths) {
      const tempId = crypto.randomUUID();
      tempIds.push(tempId);
      const fileName = filePath.split(/[\\/]/).pop() || 'file';
      setAttachments(prev => [...prev, {
        id: tempId,
        fileName,
        mimeType: '',
        fileSize: 0,
        stagedPath: '',
        preview: null,
        status: 'staging' as const,
      }]);
    }

    try {
      console.log('[stagePathFiles] Staging files:', filePaths);
      const staged = await hostApiFetch<Array<{
        id: string;
        fileName: string;
        mimeType: string;
        fileSize: number;
        stagedPath: string;
        preview: string | null;
      }>>('/api/files/stage-paths', {
        method: 'POST',
        body: JSON.stringify({ filePaths }),
      });
      console.log('[stagePathFiles] Stage result:', staged?.map(s => ({ id: s?.id, fileName: s?.fileName, mimeType: s?.mimeType, fileSize: s?.fileSize, stagedPath: s?.stagedPath, hasPreview: !!s?.preview })));
      showUnsupportedImageEditReferenceToast(staged, t);

      setAttachments(prev => {
        let updated = [...prev];
        for (let i = 0; i < tempIds.length; i++) {
          const tempId = tempIds[i];
          const data = staged[i];
          if (data) {
            updated = updated.map(a =>
              a.id === tempId
                ? { ...data, status: 'ready' as const }
                : a,
            );
          } else {
            console.warn(`[stagePathFiles] No staged data for tempId=${tempId} at index ${i}`);
            updated = updated.map(a =>
              a.id === tempId
                ? { ...a, status: 'error' as const, error: 'Staging failed' }
                : a,
            );
          }
        }
        return updated;
      });
    } catch (err) {
      console.error('[stagePathFiles] Failed to stage files:', err);
      setAttachments(prev => prev.map(a =>
        a.status === 'staging'
          ? { ...a, status: 'error' as const, error: String(err) }
          : a,
      ));
    }
  }, [t]);

  const pickFiles = useCallback(async () => {
    try {
      const result = await invokeIpc('dialog:open', {
        properties: ['openFile', 'multiSelections'],
      }) as { canceled: boolean; filePaths?: string[] };
      if (result.canceled || !result.filePaths?.length) return;
      await stagePathFiles(result.filePaths);
    } catch (err) {
      console.error('[pickFiles] Failed to open file dialog:', err);
    }
  }, [stagePathFiles]);

  // ── Stage browser File objects (paste / drag-drop) ─────────────

  const stageBufferFiles = useCallback(async (files: globalThis.File[]) => {
    showUnsupportedImageEditReferenceToast(files, t);
    for (const file of files) {
      const tempId = crypto.randomUUID();
      setAttachments(prev => [...prev, {
        id: tempId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        fileSize: file.size,
        stagedPath: '',
        preview: null,
        status: 'staging' as const,
      }]);

      try {
        console.log(`[stageBuffer] Reading file: ${file.name} (${file.type}, ${file.size} bytes)`);
        const base64 = await readFileAsBase64(file);
        console.log(`[stageBuffer] Base64 length: ${base64?.length ?? 'null'}`);
        const staged = await hostApiFetch<{
          id: string;
          fileName: string;
          mimeType: string;
          fileSize: number;
          stagedPath: string;
          preview: string | null;
        }>('/api/files/stage-buffer', {
          method: 'POST',
          body: JSON.stringify({
            base64,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
          }),
        });
        console.log(`[stageBuffer] Staged: id=${staged?.id}, path=${staged?.stagedPath}, size=${staged?.fileSize}`);
        setAttachments(prev => prev.map(a =>
          a.id === tempId ? { ...staged, status: 'ready' as const } : a,
        ));
      } catch (err) {
        console.error(`[stageBuffer] Error staging ${file.name}:`, err);
        setAttachments(prev => prev.map(a =>
          a.id === tempId
            ? { ...a, status: 'error' as const, error: String(err) }
            : a,
        ));
      }
    }
  }, [t]);

  // ── Attachment management ──────────────────────────────────────

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const allReady = attachments.length === 0 || attachments.every(a => a.status === 'ready');
  const hasFailedAttachments = attachments.some((a) => a.status === 'error');
  const canSend = (input.trim() || attachments.length > 0) && allReady && !inputDisabled && !sending;
  const canStop = sending && !inputDisabled && !!onStop;

  const handleSend = useCallback(async () => {
    if (!canSend) return;
    const readyAttachments = attachments.filter(a => a.status === 'ready');
    const textToSend = input.trim();
    const imageReferenceAttachment = (sendMode === 'image' || sendMode === 'video') && imageEditReference?.filePath
      ? {
        id: `image-edit-reference:${imageEditReference.filePath}`,
        fileName: imageEditReference.fileName || imageEditReference.filePath.split(/[\\/]/).pop() || 'image',
        mimeType: imageEditReference.mimeType || 'image/png',
        fileSize: imageEditReference.fileSize || 0,
        stagedPath: imageEditReference.filePath,
        preview: imageEditReference.preview,
        status: 'ready' as const,
      }
      : null;
    const dedupedReadyAttachments = imageReferenceAttachment
      ? [
        imageReferenceAttachment,
        ...readyAttachments.filter((attachment) => attachment.stagedPath !== imageReferenceAttachment.stagedPath),
      ]
      : readyAttachments;
    const attachmentsToSend = dedupedReadyAttachments.length > 0 ? dedupedReadyAttachments : undefined;

    if (rendererExtensionRegistry.hasChatBeforeSendHooks()) {
      const guard = await rendererExtensionRegistry.runChatBeforeSend({
        text: textToSend,
        attachments: attachmentsToSend,
        targetAgentId,
      });
      if (!guard.ok) {
        if (guard.message) {
          toast.error(guard.message);
        }
        return;
      }
    }

    if (effectiveModelRef && requestedModelRef !== effectiveModelRef) {
      try {
        console.info('[ChatInput] Persisting effective model before send', {
          sessionKey: currentSessionKey,
          requestedModelRef,
          effectiveModelRef,
        });
        await updateSessionModel(currentSessionKey, effectiveModelRef);
      } catch (error) {
        toast.error(t('composer.modelSwitchFailed', { error: String(error) }));
        console.error('Failed to persist effective session model before send:', error);
        return;
      }
    }

    // Capture values before clearing — clear input immediately for snappy UX,
    // but keep attachments available for the async send
    console.log(`[handleSend] text="${textToSend.substring(0, 50)}", attachments=${attachments.length}, ready=${readyAttachments.length}, sending=${!!attachmentsToSend}`);
    if (attachmentsToSend) {
      console.log('[handleSend] Attachment details:', attachmentsToSend.map(a => ({
        id: a.id, fileName: a.fileName, mimeType: a.mimeType, fileSize: a.fileSize,
        stagedPath: a.stagedPath, status: a.status, hasPreview: !!a.preview,
      })));
    }
    setInput('');
    setAttachments([]);
    setSelectedSkill(null);
    setSkillQuery('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    onSend(
      textToSend,
      attachmentsToSend,
      targetAgentId,
      sendMode,
      sendMode === 'image' ? imageOptions : undefined,
      sendMode === 'video' ? videoOptions : undefined,
    );
    if (imageReferenceAttachment) {
      onClearImageEditReference?.();
    }
    setTargetAgentId(null);
    setPickerOpen(false);
    setSkillPickerOpen(false);
  }, [
    attachments,
    canSend,
    currentSessionKey,
    effectiveModelRef,
    imageOptions,
    input,
    imageEditReference,
    onSend,
    onClearImageEditReference,
    requestedModelRef,
    sendMode,
    t,
    targetAgentId,
    updateSessionModel,
    videoOptions,
  ]);

  const handleStop = useCallback(() => {
    if (!canStop) return;
    onStop?.();
  }, [canStop, onStop]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Backspace') {
        const textarea = textareaRef.current;
        const selectionStart = textarea?.selectionStart ?? 0;
        const selectionEnd = textarea?.selectionEnd ?? 0;
        const tokenRange = skillTokenRanges.find((range) =>
          selectionStart === selectionEnd
          && selectionStart > range.start
          && selectionStart <= range.end,
        );

        if (
          tokenRange
        ) {
          e.preventDefault();
          const valueWithoutToken = `${input.slice(0, tokenRange.start)}${input.slice(tokenRange.end)}`;
          setInput(valueWithoutToken);
          setSelectedSkill(null);
          moveCaretTo(tokenRange.start);
          return;
        }

        if (!input) {
          if (selectedSkill) {
            setSelectedSkill(null);
            return;
          }
          setTargetAgentId(null);
          return;
        }
      }
      if (e.key === 'ArrowLeft' && skillTokenRanges.length > 0) {
        const textarea = textareaRef.current;
        const selectionStart = textarea?.selectionStart ?? 0;
        const selectionEnd = textarea?.selectionEnd ?? 0;
        const tokenRange = skillTokenRanges.find((range) => selectionStart === selectionEnd && selectionStart === range.end);
        if (tokenRange) {
          e.preventDefault();
          moveCaretTo(tokenRange.start);
          return;
        }
      }
      if (e.key === 'ArrowRight' && skillTokenRanges.length > 0) {
        const textarea = textareaRef.current;
        const selectionStart = textarea?.selectionStart ?? 0;
        const selectionEnd = textarea?.selectionEnd ?? 0;
        const tokenRange = skillTokenRanges.find((range) => selectionStart === selectionEnd && selectionStart === range.start);
        if (tokenRange) {
          e.preventDefault();
          moveCaretTo(tokenRange.end);
          return;
        }
      }
      if (e.key === 'Escape') {
        setPickerOpen(false);
        setSkillPickerOpen(false);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const nativeEvent = e.nativeEvent as KeyboardEvent;
        if (isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
          return;
        }
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, input, moveCaretTo, selectedSkill, skillTokenRanges],
  );

  // Handle paste (Ctrl/Cmd+V with files)
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const pastedFiles: globalThis.File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) pastedFiles.push(file);
        }
      }
      if (pastedFiles.length > 0) {
        e.preventDefault();
        stageBufferFiles(pastedFiles);
      }
    },
    [stageBufferFiles],
  );

  // Handle drag & drop
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (!e.dataTransfer) return;

      const { pathFiles, bufferFiles } = collectDroppedFiles(e.dataTransfer);
      if (pathFiles.length === 0 && bufferFiles.length === 0) {
        toast.error(t('composer.folderDropUnsupported'));
        return;
      }
      if (pathFiles.length > 0) void stagePathFiles(pathFiles);
      if (bufferFiles.length > 0) void stageBufferFiles(bufferFiles);
    },
    [stageBufferFiles, stagePathFiles, t],
  );

  return (
    <div
      className={cn(
        "p-4 pb-6 w-full mx-auto max-w-3xl"
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="w-full">
        {/* Attachment Previews */}
        {attachments.length > 0 && (
          <div className="flex gap-2 mb-3 flex-wrap">
            {attachments.map((att) => (
              <AttachmentPreview
                key={att.id}
                attachment={att}
                onRemove={() => removeAttachment(att.id)}
              />
            ))}
          </div>
        )}

        {/* Input Container */}
        <div className={`relative bg-surface-modal rounded-2xl shadow-sm border px-3 pt-2.5 pb-1.5 transition-all ${dragOver ? 'border-primary ring-1 ring-primary' : 'border-black/10 dark:border-white/10'}`}>
          {hasImageEditReference && imageEditReference && (
            <div
              className="mb-2 flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 p-2"
              data-testid="chat-image-edit-reference"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-black/10 bg-background dark:border-white/10">
                {imageEditReference.preview ? (
                  <img
                    src={imageEditReference.preview}
                    alt={imageEditReference.fileName}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <ImageIcon className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-foreground">
                  {t('composer.imageEditReferenceLabel', '修改图片')}
                </div>
                <div className="truncate text-tiny text-muted-foreground">
                  {imageEditReference.fileName}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                onClick={onClearImageEditReference}
                disabled={sending}
                title={t('composer.clearImageEditReference', '取消参考图')}
                aria-label={t('composer.clearImageEditReference', '取消参考图')}
                data-testid="chat-image-edit-reference-clear"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}

          {selectedTarget && (
            <div className="flex flex-wrap gap-2 pb-1.5">
              <button
                type="button"
                onClick={() => setTargetAgentId(null)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-1 text-meta font-medium text-foreground transition-colors hover:bg-primary/10"
                title={t('composer.clearTarget')}
              >
                <span>{t('composer.targetChip', { agent: selectedTarget.name })}</span>
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            </div>
          )}

          {/* Text Row — flush-left */}
          <div className="relative min-h-[48px]">
            {skillTokenRanges.length > 0 && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-20 overflow-hidden whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground"
              >
                {renderHighlightedComposerText(input, skillTokenRanges, {
                  onPreviewSkill: (name) => {
                    void handleSkillTokenPreview(name);
                  },
                  previewTooltip: t('composer.skillPreviewTooltip', 'Preview SKILL.md'),
                })}
              </div>
            )}
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onSelect={normalizeSelectionAroundSkill}
              onClick={normalizeSelectionAroundSkill}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
              }}
              onPaste={handlePaste}
              placeholder={inputDisabled ? t('composer.gatewayDisconnectedPlaceholder') : ''}
              disabled={inputDisabled}
              data-testid="chat-composer-input"
              className={cn(
                'relative min-h-[48px] max-h-[240px] resize-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none bg-transparent p-0 text-sm leading-relaxed placeholder:text-muted-foreground/60',
                skillTokenRanges.length > 0 ? 'z-0 text-transparent caret-foreground selection:bg-primary/20' : 'z-10',
              )}
              rows={1}
            />
          </div>

          {/* Action Row — icons on their own line */}
          <div className="mt-1.5 flex items-center gap-1">
            {/* Attach Button */}
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 h-8 w-8 rounded-lg text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground transition-colors"
              onClick={pickFiles}
              disabled={inputDisabled || sending}
              title={t('composer.attachFiles')}
            >
              <Paperclip className="h-3.5 w-3.5" />
            </Button>

            {showAgentPicker && (
              <div ref={pickerRef} className="relative shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid="chat-composer-agent"
                  className={cn(
                    'h-8 w-8 rounded-lg text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground transition-colors',
                    (pickerOpen || selectedTarget) && 'bg-primary/10 text-primary hover:bg-primary/20'
                  )}
                  onClick={() => {
                    setSkillPickerOpen(false);
                    setPickerOpen((open) => !open);
                  }}
                  disabled={inputDisabled || sending}
                  title={t('composer.pickAgent')}
                >
                  <AtSign className="h-3.5 w-3.5" />
                </Button>
                {pickerOpen && (
                  <div className="absolute left-0 bottom-full z-20 mb-2 w-72 overflow-hidden rounded-2xl border border-black/10 bg-surface-modal p-1.5 shadow-xl dark:border-white/10">
                    <div className="px-3 py-2 text-tiny font-medium text-muted-foreground/80">
                      {t('composer.agentPickerTitle', { currentAgent: currentAgentName })}
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      {mentionableAgents.map((agent) => (
                        <AgentPickerItem
                          key={agent.id}
                          agent={agent}
                          selected={agent.id === targetAgentId}
                          onSelect={() => {
                            setTargetAgentId(agent.id);
                            setPickerOpen(false);
                            textareaRef.current?.focus();
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div ref={skillPickerRef} className="relative shrink-0">
              <button
                type="button"
                data-testid="chat-composer-skill"
                className={cn(
                  'inline-flex h-8 items-center gap-1 rounded-lg px-1.5 text-meta font-medium text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground focus-visible:outline-none focus-visible:ring-0 disabled:pointer-events-none disabled:opacity-50',
                  (skillPickerOpen || selectedSkill) && 'text-foreground',
                )}
                onClick={() => {
                  setPickerOpen(false);
                  setSkillPickerOpen((open) => !open);
                }}
                disabled={inputDisabled || sending}
                title={t('composer.pickSkill')}
              >
                <span>{t('composer.skillButton')}</span>
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', skillPickerOpen && 'rotate-180')} />
              </button>
              {skillPickerOpen && (
                <div className="absolute left-0 bottom-full z-20 mb-2 w-80 overflow-hidden rounded-2xl border border-black/10 bg-surface-modal p-1.5 shadow-xl dark:border-white/10">
                  <div className="flex items-center gap-2 rounded-xl border border-black/10 bg-black/[0.03] px-3 py-2 dark:border-white/10 dark:bg-white/[0.04]">
                    <Search className="h-3.5 w-3.5 text-muted-foreground" />
                    <input
                      value={skillQuery}
                      onChange={(event) => setSkillQuery(event.target.value)}
                      placeholder={t('composer.skillSearchPlaceholder')}
                      className="w-full bg-transparent text-meta outline-none placeholder:text-muted-foreground/70"
                      autoFocus
                    />
                  </div>
                  <div className="px-3 py-2 text-tiny font-medium text-muted-foreground/80">
                    {t('composer.skillPickerTitle', { agent: currentAgentName })}
                  </div>
                  <div className="max-h-72 overflow-y-auto">
                    {skillsLoading ? (
                      <div className="px-3 py-4 text-xs text-muted-foreground">
                        {t('composer.skillLoading')}
                      </div>
                    ) : skillsError ? (
                      <div className="px-3 py-4 text-xs text-destructive">
                        {skillsError}
                      </div>
                    ) : filteredQuickSkills.length === 0 ? (
                      <div className="px-3 py-4 text-xs text-muted-foreground">
                        {t('composer.skillEmpty')}
                      </div>
                    ) : (
                      filteredQuickSkills.map((skill) => (
                        <SkillPickerItem
                          key={`${skill.source}:${skill.name}`}
                          skill={skill}
                          selected={false}
                          onSelect={() => {
                            const textarea = textareaRef.current;
                            const nextToken = getSkillPrefix(skill.name);
                            const selectionStart = textarea?.selectionStart ?? input.length;
                            const selectionEnd = textarea?.selectionEnd ?? input.length;
                            let nextValue = input;
                            let adjustedStart = selectionStart;
                            let adjustedEnd = selectionEnd;

                            const leadingSpace = needsLeadingSkillSpace(nextValue, adjustedStart) ? ' ' : '';
                            nextValue = `${nextValue.slice(0, adjustedStart)}${leadingSpace}${nextToken}${nextValue.slice(adjustedEnd)}`;
                            setSelectedSkill(null);
                            setInput(nextValue);
                            setSkillPickerOpen(false);
                            setSkillQuery('');
                            requestAnimationFrame(() => {
                              textareaRef.current?.focus();
                              const cursorPosition = adjustedStart + leadingSpace.length + nextToken.length;
                              textareaRef.current?.setSelectionRange(cursorPosition, cursorPosition);
                            });
                          }}
                        />
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            {showModelPicker && (
              <div ref={modelPickerRef} className="relative shrink-0">
                <button
                  type="button"
                  data-testid="chat-model-picker-button"
                  className={cn(
                    'inline-flex h-8 max-w-[220px] items-center gap-1 rounded-lg px-1.5 text-meta font-medium text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground focus-visible:outline-none focus-visible:ring-0 disabled:pointer-events-none disabled:opacity-50',
                    modelPickerOpen && 'text-foreground',
                  )}
                  onClick={() => {
                    setPickerOpen(false);
                    setSkillPickerOpen(false);
                    setModelPickerOpen((open) => !open);
                  }}
                  disabled={inputDisabled || sending || !currentAgent}
                  title={t('composer.pickModel')}
                >
                  <span className="truncate">{currentModelLabel}</span>
                  <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', modelPickerOpen && 'rotate-180')} />
                </button>
                {modelPickerOpen && (
                  <div
                    className="absolute left-0 bottom-full z-20 mb-2 w-72 overflow-hidden rounded-2xl border border-black/10 bg-surface-modal p-1.5 shadow-xl dark:border-white/10"
                    data-testid="chat-model-picker-menu"
                  >
                    <div className="px-3 py-2 text-tiny font-medium text-muted-foreground/80">
                      {t('composer.modelPickerTitle')}
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      {modelOptions.map((option) => (
                        <button
                          key={option.modelRef}
                          type="button"
                          onClick={() => void handleSelectModel(option.modelRef)}
                          className={cn(
                            'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors',
                            option.modelRef === effectiveModelRef ? 'bg-primary/10 text-foreground' : 'hover:bg-black/5 dark:hover:bg-white/5'
                          )}
                          data-testid={`chat-model-picker-option-${toModelOptionTestId(option.label)}`}
                        >
                          <span className="truncate">{option.label}</span>
                          {option.modelRef === effectiveModelRef && (
                            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="ml-1 flex items-center">
              <button
                type="button"
                data-testid="chat-composer-mode-image"
                className={cn(
                  'inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors',
                  sendMode === 'image'
                    ? 'bg-black/10 text-foreground dark:bg-white/10'
                    : 'hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground',
                )}
                onClick={() => {
                  if (sendMode === 'image') {
                    onClearImageEditReference?.();
                  }
                  setSessionSendModes((current) => ({
                    ...current,
                    [currentSessionKey]: current[currentSessionKey] === 'image' ? 'chat' : 'image',
                  }));
                }}
                disabled={inputDisabled || sending}
                title={sendMode === 'image' ? t('composer.imageModeActive', 'Image mode on') : t('composer.imageMode', 'Image')}
              >
                <ImageIcon className="h-4 w-4 shrink-0" />
                <span>{t('composer.imageGenerateLabel', '图像生成')}</span>
              </button>
              <button
                type="button"
                data-testid="chat-composer-mode-video"
                className={cn(
                  'ml-1 inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors',
                  sendMode === 'video'
                    ? 'bg-black/10 text-foreground dark:bg-white/10'
                    : 'hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground',
                )}
                onClick={() => {
                  const nextMode = sendMode === 'video' ? 'chat' : 'video';
                  if (nextMode === 'chat') {
                    onClearImageEditReference?.();
                  }
                  setSessionSendModes((current) => ({
                    ...current,
                    [currentSessionKey]: nextMode,
                  }));
                }}
                disabled={inputDisabled || sending}
                title={sendMode === 'video' ? t('composer.videoModeActive', 'Video mode on') : t('composer.videoMode', 'Video')}
              >
                <Film className="h-4 w-4 shrink-0" />
                <span>{t('composer.videoGenerateLabel', 'Video')}</span>
              </button>
            </div>

            {sendMode === 'image' && (
              <div className="ml-2 flex items-center gap-2" data-testid="chat-image-options">
                <Select
                  value={imageOptions.size}
                  onChange={(e) => {
                    const size = e.target.value;
                    setSessionImageOptions((current) => ({
                      ...current,
                      [currentSessionKey]: {
                        ...(current[currentSessionKey] ?? defaultImageOptions),
                        model: imageOptions.model,
                        size,
                      },
                    }));
                  }}
                  className="h-8 w-[74px] rounded-lg border-black/10 bg-transparent px-2 pr-7 text-xs text-foreground [background-image:none] appearance-none"
                  data-testid="chat-image-size"
                  aria-label={t('composer.imageSizeLabel')}
                >
                  {(selectedImageModel?.sizes ?? [imageOptions.size]).map((size) => (
                    <option key={size} value={size}>
                      {formatImageSizeLabel(size)}
                    </option>
                  ))}
                </Select>
                <Select
                  value={imageOptions.quality}
                  onChange={(e) => {
                    const quality = e.target.value;
                    setSessionImageOptions((current) => ({
                      ...current,
                      [currentSessionKey]: {
                        ...(current[currentSessionKey] ?? defaultImageOptions),
                        model: imageOptions.model,
                        quality,
                      },
                    }));
                  }}
                  className="h-8 w-[88px] rounded-lg border-black/10 bg-transparent px-2 pr-7 text-xs text-foreground [background-image:none] appearance-none"
                  data-testid="chat-image-quality"
                  aria-label={t('composer.imageQualityLabel')}
                >
                  {(selectedImageModel?.qualities ?? [imageOptions.quality]).map((quality) => (
                    <option key={quality} value={quality}>
                      {formatImageQualityLabel(quality, t)}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            {/* Send Button — pushed to the right */}
            {sendMode === 'video' && (
              <div className="ml-2 flex items-center gap-2" data-testid="chat-video-options">
                <Select
                  value={videoOptions.size}
                  onChange={(e) => {
                    const size = e.target.value;
                    setSessionVideoOptions((current) => ({
                      ...current,
                      [currentSessionKey]: {
                        ...(current[currentSessionKey] ?? defaultVideoOptions),
                        size,
                      },
                    }));
                  }}
                  className="h-8 w-[82px] rounded-lg border-black/10 bg-transparent px-2 pr-7 text-xs text-foreground [background-image:none] appearance-none"
                  data-testid="chat-video-size"
                  aria-label={t('composer.videoSizeLabel', 'Video size')}
                >
                  {(selectedVideoModel?.sizes ?? [videoOptions.size]).map((size) => (
                    <option key={size} value={size}>
                      {formatVideoSizeLabel(size)}
                    </option>
                  ))}
                </Select>
                <Select
                  value={String(videoOptions.durationSeconds)}
                  onChange={(e) => {
                    const durationSeconds = Number(e.target.value);
                    setSessionVideoOptions((current) => ({
                      ...current,
                      [currentSessionKey]: {
                        ...(current[currentSessionKey] ?? defaultVideoOptions),
                        durationSeconds,
                      },
                    }));
                  }}
                  className="h-8 w-[74px] rounded-lg border-black/10 bg-transparent px-2 pr-7 text-xs text-foreground [background-image:none] appearance-none"
                  data-testid="chat-video-duration"
                  aria-label={t('composer.videoDurationLabel', 'Video duration')}
                >
                  {(selectedVideoModel?.durations ?? [videoOptions.durationSeconds]).map((duration) => (
                    <option key={duration} value={duration}>
                      {duration}s
                    </option>
                  ))}
                </Select>
              </div>
            )}

            <Button
              onClick={sending ? handleStop : handleSend}
              disabled={sending ? !canStop : !canSend}
              size="icon"
              data-testid="chat-composer-send"
              className={`ml-auto shrink-0 h-8 w-8 rounded-lg transition-colors ${
                (sending || canSend)
                  ? 'bg-black/5 dark:bg-white/10 text-foreground hover:bg-black/10 dark:hover:bg-white/20'
                  : 'text-muted-foreground/50 hover:bg-transparent bg-transparent'
              }`}
              variant="ghost"
              title={sending ? t('composer.stop') : t('composer.send')}
            >
              {sending ? (
                <Square className="h-3.5 w-3.5" fill="currentColor" />
              ) : (
                <SendHorizontal className="h-4 w-4" strokeWidth={2} />
              )}
            </Button>
          </div>
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-2 text-tiny text-muted-foreground/60 px-4">
          <div className="flex min-w-0 items-center gap-1.5">
            <div className={cn(
              "w-1.5 h-1.5 rounded-full",
              isGatewayUsable ? "bg-green-500/80" : "bg-red-500/80",
            )} />
            <span>
              {t('composer.gatewayStatus', {
                state: isGatewayUsable
                  ? t('composer.gatewayConnected')
                  : gatewayStatus.state === 'running'
                    ? 'starting'
                    : gatewayStatus.state,
                port: gatewayStatus.port,
                pid: gatewayStatus.pid ? `| pid: ${gatewayStatus.pid}` : '',
              })}
            </span>
            {chatComposerStatusComponents.map((Component, index) => (
              <Component key={`${index}`} gatewayStatus={gatewayStatus} />
            ))}
            {sending && (
              <span className="ml-2 truncate text-muted-foreground/75" data-testid="chat-composer-busy-hint">
                {t(
                  'composer.busyHint',
                  'Current task is still running. Messages already accepted by OpenClaw will wait for the current work to finish.',
                )}
              </span>
            )}
          </div>
          {hasFailedAttachments && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-tiny"
              onClick={() => {
                setAttachments((prev) => prev.filter((att) => att.status !== 'error'));
                void pickFiles();
              }}
            >
              {t('composer.retryFailedAttachments')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Attachment Preview ───────────────────────────────────────────

function AttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: FileAttachment;
  onRemove: () => void;
}) {
  const { t } = useTranslation('chat');
  const isImage = attachment.mimeType.startsWith('image/') && attachment.preview;

  return (
    <div className="relative group rounded-lg overflow-hidden border border-border">
      {isImage ? (
        // Image thumbnail
        <div className="w-16 h-16">
          <img
            src={attachment.preview!}
            alt={attachment.fileName}
            className="w-full h-full object-cover"
          />
        </div>
      ) : (
        // Generic file card
        <div className="flex items-center gap-2 px-3 py-2 bg-surface-input/50 max-w-[200px]">
          <FileIcon mimeType={attachment.mimeType} className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 overflow-hidden">
            <p className="text-xs font-medium truncate">{attachment.fileName}</p>
            <p className="text-2xs text-muted-foreground">
              {attachment.mimeType === DIRECTORY_MIME_TYPE
                ? t('composer.folderAttachment')
                : attachment.fileSize > 0
                  ? formatFileSize(attachment.fileSize)
                  : '...'}
            </p>
          </div>
        </div>
      )}

      {/* Staging overlay */}
      {attachment.status === 'staging' && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
          <Loader2 className="h-4 w-4 text-white animate-spin" />
        </div>
      )}

      {/* Error overlay */}
      {attachment.status === 'error' && (
        <div className="absolute inset-0 bg-destructive/20 flex items-center justify-center">
          <span className="text-2xs text-destructive font-medium px-1">Error</span>
        </div>
      )}

      {/* Remove button */}
      <button
        onClick={onRemove}
        className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function AgentPickerItem({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col items-start rounded-xl px-3 py-2 text-left transition-colors',
        selected ? 'bg-primary/10 text-foreground' : 'hover:bg-black/5 dark:hover:bg-white/5'
      )}
    >
      <span className="text-sm font-medium text-foreground">{agent.name}</span>
      <span className="text-tiny text-muted-foreground">
        {agent.modelDisplay}
      </span>
    </button>
  );
}

function SkillPickerItem({
  skill,
  selected,
  onSelect,
}: {
  skill: QuickAccessSkill;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid={`chat-composer-skill-option-${skill.name}`}
          onClick={onSelect}
          className={cn(
            'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors',
            selected ? 'bg-primary/10 text-foreground' : 'hover:bg-black/5 dark:hover:bg-white/5',
          )}
        >
          <div className="min-w-0">
            <div className="truncate text-meta font-semibold text-foreground">
              <span className="font-mono">/{skill.name}</span>
            </div>
            <div className="truncate text-tiny text-muted-foreground">
              {skill.sourceLabel}
            </div>
          </div>
          <span className="rounded-full border border-black/10 bg-black/[0.03] px-2 py-0.5 text-2xs font-medium text-muted-foreground dark:border-white/10 dark:bg-white/[0.04]">
            {skill.sourceLabel}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs text-xs leading-relaxed">
        {skill.description}
      </TooltipContent>
    </Tooltip>
  );
}
