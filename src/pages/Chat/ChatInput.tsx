/**
 * Chat Input Component
 * Textarea with send button and universal file upload support.
 * Enter to send, Shift+Enter for new line.
 * Supports: native file picker, clipboard paste, drag & drop.
 * Files are staged to disk via IPC — only lightweight path references
 * are sent with the message (no base64 over WebSocket).
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { SendHorizontal, Square, X, Paperclip, FileText, Film, Music, FileArchive, File, FolderOpen, Loader2, AtSign, Search, ChevronDown, ChevronRight, Check, Image as ImageIcon, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { hostApi } from '@/lib/host-api';
import { cn } from '@/lib/utils';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { useChatStore } from '@/stores/chat';
import { useManagedClientConfigStore } from '@/stores/managed-client-config';
import { useArtifactPanel } from '@/stores/artifact-panel';
import { buildPreviewTarget } from '@/components/file-preview/build-preview-target';
import { buildManagedTextModelOptions, formatModelRefLabel, resolveConfiguredModelRef } from '@/lib/model-options';
import { toManagedClientTextModelRef } from '@shared/managed-client-config';
import type { AgentSummary } from '@/types/agent';
import type { QuickAccessSkill } from '@/types/skill';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { rendererExtensionRegistry } from '@/extensions/registry';
import { collectDroppedFiles } from '@/lib/collect-dropped-files';
import { fetchQuickAccessSkills } from '@/lib/quick-access-skills';
import { DEFAULT_WORKSPACE_CWD, isDefaultWorkspacePath, normalizeWorkspacePath } from '@/lib/workspace-context';
import type { AcpImageGenerationOptions } from '@shared/acp-chat/types';
import { UCLAW_DEFAULT_THINKING_LEVEL } from '@shared/junfeiai-endpoints';

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

export interface ChatWorkspaceOption {
  path: string;
  label: string;
}

interface ChatInputProps {
  onSend: (
    text: string,
    attachments?: FileAttachment[],
    targetAgentId?: string | null,
    imageOptions?: AcpImageGenerationOptions,
  ) => void;
  onStop?: () => void;
  disabled?: boolean;
  sending?: boolean;
  imageGenerating?: boolean;
  workspaceLabel?: string;
  workspacePath?: string;
  workspaceOptions?: ChatWorkspaceOption[];
  workspaceReadOnly?: boolean;
  onSelectWorkspace?: (path: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────

const DIRECTORY_MIME_TYPE = 'application/x-directory';
const DEFAULT_IMAGE_OPTIONS: AcpImageGenerationOptions = {
  size: '1024x1024',
  quality: 'medium',
};
const IMAGE_ASPECT_OPTIONS: ReadonlyArray<{
  ratio: string;
  size: AcpImageGenerationOptions['size'];
  labelKey: string;
  previewClassName: string;
  testId: string;
}> = [
  { ratio: '2:3', size: '1024x1536', labelKey: 'composer.imageAspectTall', previewClassName: 'h-6 w-4', testId: 'chat-image-aspect-2-3' },
  { ratio: '3:2', size: '1536x1024', labelKey: 'composer.imageAspectWide', previewClassName: 'h-4 w-6', testId: 'chat-image-aspect-3-2' },
  { ratio: '1:1', size: '1024x1024', labelKey: 'composer.imageAspectSquare', previewClassName: 'h-5 w-5', testId: 'chat-image-aspect-1-1' },
  { ratio: '9:16', size: '2160x3840', labelKey: 'composer.imageAspectVertical', previewClassName: 'h-6 w-3.5', testId: 'chat-image-aspect-9-16' },
  { ratio: '16:9', size: '3840x2160', labelKey: 'composer.imageAspectWidescreen', previewClassName: 'h-3.5 w-6', testId: 'chat-image-aspect-16-9' },
];
const IMAGE_QUALITY_OPTIONS: AcpImageGenerationOptions['quality'][] = ['low', 'medium', 'high'];
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const INHERIT_THINKING_VALUE = '__inherit__';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatImageQualityLabel(value: AcpImageGenerationOptions['quality'], t: ReturnType<typeof useTranslation>['t']): string {
  if (value === 'low') return t('composer.imageQualityLow');
  if (value === 'high') return t('composer.imageQualityHigh');
  return t('composer.imageQualityMedium');
}

function getSkillPrefix(skillName: string): string {
  return `/${skillName}  `;
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
  imageGenerating = false,
  workspaceLabel,
  workspacePath,
  workspaceOptions = [],
  workspaceReadOnly = false,
  onSelectWorkspace,
}: ChatInputProps) {
  const { t } = useTranslation('chat');
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [settingsPickerOpen, setSettingsPickerOpen] = useState(false);
  const [imageAspectPickerOpen, setImageAspectPickerOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState('');
  const [quickSkills, setQuickSkills] = useState<QuickAccessSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<QuickAccessSkill | null>(null);
  const [optimisticModelRef, setOptimisticModelRef] = useState<string | null>(null);
  const [sessionImageModes, setSessionImageModes] = useState<Record<string, boolean>>({});
  const [sessionImageOptions, setSessionImageOptions] = useState<Record<string, AcpImageGenerationOptions>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const skillPickerRef = useRef<HTMLDivElement>(null);
  const imageAspectPickerRef = useRef<HTMLDivElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const modelChangeVersionRef = useRef(0);
  const mountedRef = useRef(true);
  const sendAttemptInFlightRef = useRef<{
    sessionKey: string;
    sessionGeneration: number;
    token: symbol;
  } | null>(null);
  const isComposingRef = useRef(false);
  const closeSettingsPicker = useCallback(() => {
    setSettingsPickerOpen(false);
  }, []);
  const handleSettingsPickerOpenChange = useCallback((open: boolean) => {
    setSettingsPickerOpen(open);
  }, []);
  const gatewayStatus = useGatewayStore((s) => s.status);
  const agents = useAgentsStore((s) => s.agents);
  const defaultModelRef = useAgentsStore((s) => s.defaultModelRef);
  const textModelPolicy = useManagedClientConfigStore((s) => s.textModelPolicy);
  const loadManagedTextModels = useManagedClientConfigStore((s) => s.loadTextModels);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const currentSessionKeyRef = useRef(currentSessionKey);
  const previousSessionKeyRef = useRef(currentSessionKey);
  const currentSessionGenerationRef = useRef(0);
  if (previousSessionKeyRef.current !== currentSessionKey) {
    previousSessionKeyRef.current = currentSessionKey;
    currentSessionGenerationRef.current += 1;
  }
  currentSessionKeyRef.current = currentSessionKey;
  const sessions = useChatStore((s) => s.sessions);
  const thinkingLevel = useChatStore((s) => s.thinkingLevel);
  const updateSessionModel = useChatStore((s) => s.updateSessionModel);
  const waitForSessionModelUpdate = useChatStore((s) => s.waitForSessionModelUpdate);
  const updateSessionThinking = useChatStore((s) => s.updateSessionThinking);
  const waitForSessionThinkingUpdate = useChatStore((s) => s.waitForSessionThinkingUpdate);
  const modelPersisting = useChatStore(
    (s) => Boolean(s.pendingSessionModelUpdates[currentSessionKey]),
  );
  const thinkingPersisting = useChatStore(
    (s) => Boolean(s.pendingSessionThinkingUpdates[currentSessionKey]),
  );
  const currentAgent = useMemo(
    () => (agents ?? []).find((agent) => agent.id === currentAgentId) ?? null,
    [agents, currentAgentId],
  );
  const currentSession = useMemo(
    () => (sessions ?? []).find((session) => session.key === currentSessionKey) ?? null,
    [currentSessionKey, sessions],
  );
  const selectedThinkingLevel = (currentSession?.thinkingLevel ?? thinkingLevel ?? '').trim();
  const thinkingOptions = useMemo(() => {
    const configured = currentSession?.thinkingLevels ?? [];
    const options: Array<{ id: string; label?: string }> = configured.length > 0
      ? configured
      : THINKING_LEVELS.map((id) => ({ id }));
    if (selectedThinkingLevel && !options.some((option) => option.id === selectedThinkingLevel)) {
      return [...options, { id: selectedThinkingLevel }];
    }
    return options;
  }, [currentSession?.thinkingLevels, selectedThinkingLevel]);
  const thinkingLevelLabel = useCallback((id: string, fallback?: string) => (
    t(`composer.thinkingLevels.${id}`, { defaultValue: fallback || id })
  ), [t]);
  const inheritedThinkingLabel = useMemo(() => {
    const defaultLevel = currentSession?.thinkingDefault || UCLAW_DEFAULT_THINKING_LEVEL;
    return thinkingLevelLabel(
      defaultLevel,
      thinkingOptions.find((option) => option.id === defaultLevel)?.label,
    );
  }, [currentSession?.thinkingDefault, thinkingLevelLabel, thinkingOptions]);
  const thinkingButtonLabel = useMemo(() => {
    if (!selectedThinkingLevel) return inheritedThinkingLabel;
    return thinkingLevelLabel(
      selectedThinkingLevel,
      thinkingOptions.find((option) => option.id === selectedThinkingLevel)?.label,
    );
  }, [inheritedThinkingLabel, selectedThinkingLevel, thinkingLevelLabel, thinkingOptions]);
  const imageModeActive = sessionImageModes[currentSessionKey] === true;
  const imageOptions = useMemo<AcpImageGenerationOptions>(
    () => ({
      ...DEFAULT_IMAGE_OPTIONS,
      ...sessionImageOptions[currentSessionKey],
    }),
    [currentSessionKey, sessionImageOptions],
  );
  const currentAgentName = useMemo(
    () => currentAgent?.name ?? currentAgentId,
    [currentAgent, currentAgentId],
  );
  const modelOptions = useMemo(
    () => buildManagedTextModelOptions(textModelPolicy),
    [textModelPolicy],
  );
  const managedDefaultModelRef = toManagedClientTextModelRef(textModelPolicy.defaultModel);
  const requestedModelRef = optimisticModelRef
    || currentSession?.model
    || currentAgent?.modelRef
    || defaultModelRef
    || null;
  const configuredModelRef = useMemo(
    () => resolveConfiguredModelRef(
      requestedModelRef,
      defaultModelRef || managedDefaultModelRef,
      modelOptions,
    ),
    [defaultModelRef, managedDefaultModelRef, modelOptions, requestedModelRef],
  );
  const effectiveModelRef = configuredModelRef;
  const currentModelLabel = useMemo(() => {
    const matchedOption = modelOptions.find((option) => option.modelRef === effectiveModelRef);
    return matchedOption?.label || formatModelRefLabel(effectiveModelRef);
  }, [effectiveModelRef, modelOptions]);
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
  const showModelPicker = modelOptions.length > 0;
  const settingsAreDefault = effectiveModelRef === managedDefaultModelRef && !selectedThinkingLevel;
  const chatComposerStatusComponents = rendererExtensionRegistry.getChatComposerStatusComponents();
  const isGatewayUsable = gatewayStatus.state === 'running' && gatewayStatus.gatewayReady !== false;
  const inputDisabled = disabled;
  const workspaceSelectorDisabled = workspaceReadOnly || inputDisabled || sending || !onSelectWorkspace;
  const skillTokenRanges = useMemo(() => findSkillTokenRanges(input), [input]);
  const openArtifactPreview = useArtifactPanel((s) => s.openPreview);
  useEffect(() => {
    void loadManagedTextModels(true).catch(() => undefined);
  }, [loadManagedTextModels]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setOptimisticModelRef(null);
  }, [currentSession?.model, currentSessionKey]);

  useEffect(() => {
    modelChangeVersionRef.current += 1;
  }, [currentSessionKey]);

  useEffect(() => {
    if (workspaceSelectorDisabled) {
      setWorkspaceMenuOpen(false);
    }
  }, [workspaceSelectorDisabled]);

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
    if (!pickerOpen && !skillPickerOpen && !imageAspectPickerOpen && !workspaceMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideAgentPicker = pickerRef.current?.contains(target);
      const insideSkillPicker = skillPickerRef.current?.contains(target);
      const insideImageAspectPicker = imageAspectPickerRef.current?.contains(target);
      const insideWorkspaceMenu = workspaceMenuRef.current?.contains(target);
      if (!insideAgentPicker && !insideSkillPicker && !insideImageAspectPicker && !insideWorkspaceMenu) {
        setPickerOpen(false);
        setSkillPickerOpen(false);
        setImageAspectPickerOpen(false);
        setWorkspaceMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [imageAspectPickerOpen, pickerOpen, skillPickerOpen, workspaceMenuOpen]);

  useEffect(() => {
    if (!pickerOpen && !skillPickerOpen && !settingsPickerOpen && !imageAspectPickerOpen && !workspaceMenuOpen) return;
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setPickerOpen(false);
      setSkillPickerOpen(false);
      closeSettingsPicker();
      setImageAspectPickerOpen(false);
      setWorkspaceMenuOpen(false);
    };
    document.addEventListener('keydown', handleDocumentKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleDocumentKeyDown, true);
    };
  }, [closeSettingsPicker, imageAspectPickerOpen, pickerOpen, settingsPickerOpen, skillPickerOpen, workspaceMenuOpen]);

  useEffect(() => {
    setSelectedSkill((prev) => {
      if (prev) {
        setInput((currentInput) => removeSkillToken(currentInput, prev.name));
      }
      return null;
    });
    setSkillPickerOpen(false);
    closeSettingsPicker();
    setWorkspaceMenuOpen(false);
    setSkillQuery('');
    setQuickSkills([]);
    setSkillsError(null);
  }, [closeSettingsPicker, currentAgentId]);

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
      const result = await fetchQuickAccessSkills({
        workspace: currentAgent.workspace,
        agentDir: currentAgent.agentDir,
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

  const handleSelectModel = useCallback((modelRef: string) => {
    if (modelRef === effectiveModelRef && requestedModelRef === effectiveModelRef) {
      closeSettingsPicker();
      textareaRef.current?.focus();
      return;
    }

    const previousModelRef = effectiveModelRef;
    const desiredOverride = modelRef === managedDefaultModelRef ? null : modelRef;
    const changeVersion = modelChangeVersionRef.current + 1;
    modelChangeVersionRef.current = changeVersion;
    setOptimisticModelRef(modelRef);
    closeSettingsPicker();
    textareaRef.current?.focus();

    const sessionKey = currentSessionKey;
    const sessionGeneration = currentSessionGenerationRef.current;
    const update = updateSessionModel(sessionKey, desiredOverride);
    void update.catch((error) => {
      if (!mountedRef.current) return;
      const selectionIsCurrent = currentSessionKeyRef.current === sessionKey
        && currentSessionGenerationRef.current === sessionGeneration;
      if (selectionIsCurrent && modelChangeVersionRef.current === changeVersion) {
        setOptimisticModelRef(previousModelRef);
      }
      if (selectionIsCurrent) {
        toast.error(t('composer.modelSwitchFailed', { error: String(error) }));
      }
    });
  }, [closeSettingsPicker, currentSessionKey, effectiveModelRef, managedDefaultModelRef, requestedModelRef, t, updateSessionModel]);

  const handleSelectThinking = useCallback((nextThinkingLevel: string) => {
    const normalizedThinkingLevel = nextThinkingLevel.trim() || null;
    if (normalizedThinkingLevel === (selectedThinkingLevel || null)) {
      closeSettingsPicker();
      textareaRef.current?.focus();
      return;
    }

    closeSettingsPicker();
    textareaRef.current?.focus();
    const sessionKey = currentSessionKey;
    const sessionGeneration = currentSessionGenerationRef.current;
    const update = updateSessionThinking(sessionKey, normalizedThinkingLevel);
    void update.catch((error) => {
      if (!mountedRef.current) return;
      const selectionIsCurrent = currentSessionKeyRef.current === sessionKey
        && currentSessionGenerationRef.current === sessionGeneration;
      if (selectionIsCurrent) {
        toast.error(t('composer.thinkingSwitchFailed', { error: String(error) }));
      }
    });
  }, [closeSettingsPicker, currentSessionKey, selectedThinkingLevel, t, updateSessionThinking]);

  const handleResetSettings = useCallback(() => {
    closeSettingsPicker();
    handleSelectModel(managedDefaultModelRef);
    handleSelectThinking('');
  }, [closeSettingsPicker, handleSelectModel, handleSelectThinking, managedDefaultModelRef]);

  const toggleImageMode = useCallback(() => {
    setPickerOpen(false);
    setSkillPickerOpen(false);
    closeSettingsPicker();
    setImageAspectPickerOpen(false);
    setWorkspaceMenuOpen(false);
    setSessionImageModes((current) => ({
      ...current,
      [currentSessionKey]: !current[currentSessionKey],
    }));
    textareaRef.current?.focus();
  }, [closeSettingsPicker, currentSessionKey]);

  const updateImageOptions = useCallback((next: Partial<AcpImageGenerationOptions>) => {
    setSessionImageOptions((current) => ({
      ...current,
      [currentSessionKey]: {
        ...DEFAULT_IMAGE_OPTIONS,
        ...current[currentSessionKey],
        ...next,
      },
    }));
  }, [currentSessionKey]);

  const handleWorkspaceButtonClick = useCallback(() => {
    if (workspaceSelectorDisabled) return;
    setPickerOpen(false);
    setSkillPickerOpen(false);
    closeSettingsPicker();
    setImageAspectPickerOpen(false);
    setWorkspaceMenuOpen((open) => !open);
  }, [closeSettingsPicker, workspaceSelectorDisabled]);

  const handleWorkspaceKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    setWorkspaceMenuOpen(false);
    event.stopPropagation();
  }, []);

  const handleSelectWorkspace = useCallback((path: string) => {
    if (workspaceSelectorDisabled || !onSelectWorkspace) return;
    onSelectWorkspace(path);
    setWorkspaceMenuOpen(false);
    textareaRef.current?.focus();
  }, [onSelectWorkspace, workspaceSelectorDisabled]);

  const handleSelectDefaultWorkspace = useCallback(() => {
    handleSelectWorkspace(DEFAULT_WORKSPACE_CWD);
  }, [handleSelectWorkspace]);

  const handleChooseOtherWorkspace = useCallback(async () => {
    if (workspaceSelectorDisabled || !onSelectWorkspace) return;
    setWorkspaceMenuOpen(false);
    try {
      const result = await hostApi.dialog.open({
        title: t('composer.workspacePickerTitle'),
        buttonLabel: t('composer.workspacePickerButton'),
        defaultPath: workspacePath,
        properties: ['openDirectory', 'createDirectory'],
      });
      const selected = result.filePaths[0]?.trim();
      if (!result.canceled && selected) onSelectWorkspace(selected);
    } catch {
      toast.error(t('composer.workspacePickerFailed'));
    } finally {
      textareaRef.current?.focus();
    }
  }, [onSelectWorkspace, t, workspacePath, workspaceSelectorDisabled]);

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
      const staged = await hostApi.files.stagePaths({ filePaths });
      console.log('[stagePathFiles] Stage result:', staged?.map(s => ({ id: s?.id, fileName: s?.fileName, mimeType: s?.mimeType, fileSize: s?.fileSize, stagedPath: s?.stagedPath, hasPreview: !!s?.preview })));

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
  }, []);

  const pickFiles = useCallback(async () => {
    try {
      const result = await hostApi.dialog.open({
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || !result.filePaths?.length) return;
      await stagePathFiles(result.filePaths);
    } catch (err) {
      console.error('[pickFiles] Failed to open file dialog:', err);
    }
  }, [stagePathFiles]);

  // ── Stage browser File objects (paste / drag-drop) ─────────────

  const stageBufferFiles = useCallback(async (files: globalThis.File[]) => {
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
        const staged = await hostApi.files.stageBuffer({
          base64,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
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
  }, []);

  // ── Attachment management ──────────────────────────────────────

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const allReady = attachments.length === 0 || attachments.every(a => a.status === 'ready');
  const hasFailedAttachments = attachments.some((a) => a.status === 'error');
  const canSendWithoutModelPersistence = (input.trim() || attachments.length > 0)
    && allReady
    && !inputDisabled
    && !sending
    && !imageGenerating;
  const canSend = canSendWithoutModelPersistence && !modelPersisting && !thinkingPersisting;
  const canStop = sending && !inputDisabled && !!onStop;

  const handleSend = useCallback(async () => {
    if (!canSendWithoutModelPersistence) return;
    const sessionKey = currentSessionKey;
    const sessionGeneration = currentSessionGenerationRef.current;
    const activeAttempt = sendAttemptInFlightRef.current;
    if (
      activeAttempt?.sessionKey === sessionKey
      && activeAttempt.sessionGeneration === sessionGeneration
    ) return;

    const token = Symbol('chat-send-attempt');
    sendAttemptInFlightRef.current = { sessionKey, sessionGeneration, token };
    const isCurrentSendContext = (): boolean => (
      mountedRef.current
      && currentSessionKeyRef.current === sessionKey
      && currentSessionGenerationRef.current === sessionGeneration
    );

    try {
      try {
        await Promise.all([
          waitForSessionModelUpdate(sessionKey),
          waitForSessionThinkingUpdate(sessionKey),
        ]);
      } catch {
        return;
      }
      if (!isCurrentSendContext()) return;

      const readyAttachments = attachments.filter(a => a.status === 'ready');
      const textToSend = input.trim();
      const attachmentsToSend = readyAttachments.length > 0 ? readyAttachments : undefined;

      if (rendererExtensionRegistry.hasChatBeforeSendHooks()) {
        const guard = await rendererExtensionRegistry.runChatBeforeSend({
          text: textToSend,
          attachments: attachmentsToSend,
          targetAgentId,
        });
        if (!isCurrentSendContext()) return;
        if (!guard.ok) {
          if (guard.message) {
            toast.error(guard.message);
          }
          return;
        }
      }

      if (effectiveModelRef && requestedModelRef !== effectiveModelRef) {
        try {
          await updateSessionModel(sessionKey, effectiveModelRef);
          await waitForSessionModelUpdate(sessionKey);
        } catch (error) {
          if (isCurrentSendContext()) {
            toast.error(t('composer.modelSwitchFailed', { error: String(error) }));
          }
          return;
        }
        if (!isCurrentSendContext()) return;
      }

      if (!isCurrentSendContext()) return;
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
      if (imageModeActive) {
        onSend(textToSend, attachmentsToSend, targetAgentId, { ...imageOptions });
      } else {
        onSend(textToSend, attachmentsToSend, targetAgentId);
      }
      setTargetAgentId(null);
      setPickerOpen(false);
      setSkillPickerOpen(false);
      closeSettingsPicker();
      setImageAspectPickerOpen(false);
      setWorkspaceMenuOpen(false);
    } finally {
      if (sendAttemptInFlightRef.current?.token === token) {
        sendAttemptInFlightRef.current = null;
      }
    }
  }, [
    input,
    attachments,
    canSendWithoutModelPersistence,
    closeSettingsPicker,
    currentSessionKey,
    effectiveModelRef,
    imageModeActive,
    imageOptions,
    onSend,
    requestedModelRef,
    t,
    targetAgentId,
    updateSessionModel,
    waitForSessionModelUpdate,
    waitForSessionThinkingUpdate,
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
        closeSettingsPicker();
        setImageAspectPickerOpen(false);
        setWorkspaceMenuOpen(false);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const nativeEvent = e.nativeEvent as KeyboardEvent;
        if (isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
          return;
        }
        e.preventDefault();
        void handleSend();
      }
    },
    [closeSettingsPicker, handleSend, input, moveCaretTo, selectedSkill, skillTokenRanges],
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
        {sending && (
          <div
            data-testid="chat-composer-working-indicator"
            role="status"
            aria-live="polite"
            aria-label={t('composer.thinking')}
            className="mb-2 flex h-5 items-center gap-2 text-sm text-muted-foreground"
          >
            <span
              data-testid="chat-composer-dot-pulse"
              aria-hidden="true"
              className="clawx-chat-thinking-dot-pulse"
            >
              <span className="clawx-chat-thinking-dot-pulse-inner">
                <span className="clawx-chat-thinking-dot-pulse-dot" />
              </span>
            </span>
            <span>{t('composer.thinking')}</span>
          </div>
        )}

        {!sending && imageGenerating && (
          <div
            data-testid="chat-composer-image-generation-indicator"
            role="status"
            aria-live="polite"
            aria-label={t('imageGeneration.generating')}
            className="mb-2 flex h-5 items-center gap-2 text-sm text-muted-foreground"
          >
            <span
              data-testid="chat-composer-image-generation-dot-pulse"
              aria-hidden="true"
              className="clawx-chat-thinking-dot-pulse"
            >
              <span className="clawx-chat-thinking-dot-pulse-inner">
                <span className="clawx-chat-thinking-dot-pulse-dot" />
              </span>
            </span>
            <span>{t('imageGeneration.generating')}</span>
          </div>
        )}

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
          <div className="mt-1.5 flex min-w-0 items-center gap-1" data-testid="chat-composer-actions">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" data-testid="chat-composer-leading-actions">
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
                    closeSettingsPicker();
                    setImageAspectPickerOpen(false);
                    setWorkspaceMenuOpen(false);
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
                  closeSettingsPicker();
                  setImageAspectPickerOpen(false);
                  setWorkspaceMenuOpen(false);
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

            <DropdownMenu open={settingsPickerOpen} onOpenChange={handleSettingsPickerOpenChange}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="chat-settings-picker-button"
                  className={cn(
                    'inline-flex h-8 min-w-0 max-w-[176px] shrink items-center gap-1.5 rounded-lg bg-black/[0.04] px-2.5 text-meta font-medium text-muted-foreground transition-colors hover:bg-black/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:pointer-events-none disabled:opacity-50 dark:bg-white/[0.07] dark:hover:bg-white/10 sm:max-w-[280px]',
                    settingsPickerOpen && 'bg-black/[0.07] text-foreground dark:bg-white/10',
                  )}
                  onClick={() => {
                    setPickerOpen(false);
                    setSkillPickerOpen(false);
                    setImageAspectPickerOpen(false);
                    setWorkspaceMenuOpen(false);
                  }}
                  disabled={inputDisabled || sending || !currentAgent}
                  title={t('composer.settingsSummary', { model: currentModelLabel, thinking: thinkingButtonLabel })}
                  aria-label={t('composer.settingsSummary', { model: currentModelLabel, thinking: thinkingButtonLabel })}
                >
                  {(modelPersisting || thinkingPersisting) && (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
                  )}
                  <span className="min-w-0 truncate text-foreground/90" data-testid="chat-settings-model-summary">
                    {currentModelLabel}
                  </span>
                  <span className="h-3 w-px shrink-0 bg-black/15 dark:bg-white/20" aria-hidden="true" />
                  <span className="shrink-0" data-testid="chat-settings-thinking-summary">{thinkingButtonLabel}</span>
                  <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', settingsPickerOpen && 'rotate-180')} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                side="top"
                sideOffset={4}
                collisionPadding={12}
                className="min-w-0 w-[min(144px,calc(100vw-24px))] rounded-lg border-black/10 p-1 shadow-md dark:border-white/10"
                data-testid="chat-settings-picker-menu"
              >
                <DropdownMenuItem
                  data-testid="chat-settings-reset"
                  onSelect={handleResetSettings}
                  disabled={settingsAreDefault}
                  className="flex h-8 gap-1.5 rounded-md bg-black/[0.04] px-2 text-xs font-medium text-foreground data-[highlighted]:bg-black/[0.07] data-[disabled]:text-muted-foreground data-[disabled]:opacity-70 dark:bg-white/[0.06] dark:data-[highlighted]:bg-white/10"
                >
                  <RotateCcw className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t('composer.resetSettings')}</span>
                </DropdownMenuItem>
                <DropdownMenuPrimitive.Separator className="my-0.5 h-px bg-black/[0.06] dark:bg-white/10" />

                <DropdownMenuPrimitive.Sub>
                  <DropdownMenuPrimitive.SubTrigger
                    data-testid="chat-settings-model-row"
                    disabled={!showModelPicker}
                    className="flex h-8 w-full cursor-default select-none items-center gap-1.5 rounded-md px-2 text-left text-xs outline-none transition-colors data-[highlighted]:bg-black/5 data-[state=open]:bg-black/5 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 dark:data-[highlighted]:bg-white/[0.06] dark:data-[state=open]:bg-white/[0.06]"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{t('composer.modelSetting')}</span>
                    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </DropdownMenuPrimitive.SubTrigger>
                  <DropdownMenuPrimitive.Portal>
                    <DropdownMenuPrimitive.SubContent
                      sideOffset={4}
                      collisionPadding={12}
                      className="z-50 max-h-[min(264px,calc(100vh-24px))] w-[min(128px,calc(100vw-24px))] overflow-y-auto rounded-lg border border-black/10 bg-surface-modal p-1 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 dark:border-white/10"
                      data-testid="chat-model-picker-menu"
                    >
                      <DropdownMenuPrimitive.RadioGroup
                        value={effectiveModelRef || ''}
                        onValueChange={handleSelectModel}
                      >
                        {modelOptions.map((option) => (
                          <DropdownMenuPrimitive.RadioItem
                            key={option.modelRef}
                            value={option.modelRef}
                            className="flex min-h-8 w-full cursor-default select-none items-center justify-between gap-1.5 rounded-md px-2 py-1 text-left text-xs font-normal text-foreground outline-none transition-colors data-[highlighted]:bg-black/5 data-[state=checked]:bg-black/5 dark:data-[highlighted]:bg-white/[0.06] dark:data-[state=checked]:bg-white/10"
                            data-testid={`chat-model-picker-option-${option.label}`}
                            title={option.label}
                          >
                            <span className="min-w-0 truncate">{option.label}</span>
                            <DropdownMenuPrimitive.ItemIndicator>
                              <Check className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
                            </DropdownMenuPrimitive.ItemIndicator>
                          </DropdownMenuPrimitive.RadioItem>
                        ))}
                      </DropdownMenuPrimitive.RadioGroup>
                    </DropdownMenuPrimitive.SubContent>
                  </DropdownMenuPrimitive.Portal>
                </DropdownMenuPrimitive.Sub>

                <DropdownMenuPrimitive.Sub>
                  <DropdownMenuPrimitive.SubTrigger
                    data-testid="chat-settings-thinking-row"
                    className="flex h-8 w-full cursor-default select-none items-center gap-1.5 rounded-md px-2 text-left text-xs outline-none transition-colors data-[highlighted]:bg-black/5 data-[state=open]:bg-black/5 dark:data-[highlighted]:bg-white/[0.06] dark:data-[state=open]:bg-white/[0.06]"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{t('composer.thinkingSetting')}</span>
                    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </DropdownMenuPrimitive.SubTrigger>
                  <DropdownMenuPrimitive.Portal>
                    <DropdownMenuPrimitive.SubContent
                      sideOffset={4}
                      collisionPadding={12}
                      className="z-50 max-h-[min(264px,calc(100vh-24px))] w-[min(128px,calc(100vw-24px))] overflow-y-auto rounded-lg border border-black/10 bg-surface-modal p-1 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 dark:border-white/10"
                      data-testid="chat-thinking-picker-menu"
                    >
                      <DropdownMenuPrimitive.RadioGroup
                        value={selectedThinkingLevel || INHERIT_THINKING_VALUE}
                        onValueChange={(value) => handleSelectThinking(value === INHERIT_THINKING_VALUE ? '' : value)}
                      >
                        <DropdownMenuPrimitive.RadioItem
                          value={INHERIT_THINKING_VALUE}
                          data-testid="chat-thinking-option-inherit"
                          className="flex min-h-8 w-full cursor-default select-none items-center justify-between gap-1.5 rounded-md px-2 py-1 text-left text-xs font-normal text-foreground outline-none transition-colors data-[highlighted]:bg-black/5 data-[state=checked]:bg-black/5 dark:data-[highlighted]:bg-white/[0.06] dark:data-[state=checked]:bg-white/10"
                        >
                          <span className="min-w-0 truncate">{t('composer.thinkingInherit', { level: inheritedThinkingLabel })}</span>
                          <DropdownMenuPrimitive.ItemIndicator>
                            <Check className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
                          </DropdownMenuPrimitive.ItemIndicator>
                        </DropdownMenuPrimitive.RadioItem>
                        {thinkingOptions.map((option) => (
                          <DropdownMenuPrimitive.RadioItem
                            key={option.id}
                            value={option.id}
                            data-testid={`chat-thinking-option-${option.id}`}
                            className="flex min-h-8 w-full cursor-default select-none items-center justify-between gap-1.5 rounded-md px-2 py-1 text-left text-xs font-normal text-foreground outline-none transition-colors data-[highlighted]:bg-black/5 data-[state=checked]:bg-black/5 dark:data-[highlighted]:bg-white/[0.06] dark:data-[state=checked]:bg-white/10"
                            title={thinkingLevelLabel(option.id, option.label)}
                          >
                            <span className="min-w-0 truncate">{thinkingLevelLabel(option.id, option.label)}</span>
                            <DropdownMenuPrimitive.ItemIndicator>
                              <Check className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
                            </DropdownMenuPrimitive.ItemIndicator>
                          </DropdownMenuPrimitive.RadioItem>
                        ))}
                      </DropdownMenuPrimitive.RadioGroup>
                    </DropdownMenuPrimitive.SubContent>
                  </DropdownMenuPrimitive.Portal>
                </DropdownMenuPrimitive.Sub>
              </DropdownMenuContent>
            </DropdownMenu>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-testid="chat-composer-mode-image"
                  aria-pressed={imageModeActive}
                  className={cn(
                    'h-8 w-8 shrink-0 rounded-lg text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10',
                    imageModeActive && 'bg-black/10 text-foreground hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/10',
                  )}
                  onClick={toggleImageMode}
                  disabled={inputDisabled || sending}
                >
                  <ImageIcon className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('composer.imageMode')}</TooltipContent>
            </Tooltip>

            {imageModeActive && (
              <div className="flex shrink-0 items-center gap-1" data-testid="chat-image-options">
                <div ref={imageAspectPickerRef} className="relative shrink-0">
                  <button
                    type="button"
                    className={cn(
                      'inline-flex h-8 min-w-[58px] items-center justify-center gap-1 rounded-lg bg-black/5 px-2 text-xs font-medium text-foreground transition-colors dark:bg-white/10',
                      imageAspectPickerOpen
                        ? 'bg-black/10 dark:bg-white/15'
                        : 'hover:bg-black/10 dark:hover:bg-white/15',
                    )}
                    onClick={() => {
                      setPickerOpen(false);
                      setSkillPickerOpen(false);
                      closeSettingsPicker();
                      setWorkspaceMenuOpen(false);
                      setImageAspectPickerOpen((open) => !open);
                    }}
                    disabled={inputDisabled || sending}
                    data-testid="chat-image-aspect-trigger"
                    aria-label={t('composer.imageSizeLabel')}
                    aria-haspopup="menu"
                    aria-expanded={imageAspectPickerOpen}
                  >
                    <span>{IMAGE_ASPECT_OPTIONS.find((option) => option.size === imageOptions.size)?.ratio ?? '1:1'}</span>
                    <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', imageAspectPickerOpen && 'rotate-180')} />
                  </button>
                  {imageAspectPickerOpen && (
                    <div
                      className="absolute bottom-full left-0 z-30 mb-2 w-[220px] rounded-lg border border-black/10 bg-surface-modal p-1 shadow-xl dark:border-white/10"
                      data-testid="chat-image-aspect-menu"
                      role="menu"
                    >
                      {IMAGE_ASPECT_OPTIONS.map((option) => {
                        const selected = option.size === imageOptions.size;
                        return (
                          <button
                            key={option.size}
                            type="button"
                            className={cn(
                              'flex h-9 w-full items-center gap-2 rounded-md px-2 text-left transition-colors',
                              selected
                                ? 'bg-black/5 text-foreground dark:bg-white/10'
                                : 'text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5',
                            )}
                            onClick={() => {
                              updateImageOptions({ size: option.size });
                              setImageAspectPickerOpen(false);
                              requestAnimationFrame(() => textareaRef.current?.focus());
                            }}
                            data-testid={option.testId}
                            role="menuitemradio"
                            aria-checked={selected}
                          >
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden="true">
                              <span className={cn(
                                'block rounded-[3px]',
                                option.previewClassName,
                                selected ? 'bg-foreground' : 'bg-muted-foreground/40',
                              )} />
                            </span>
                            <span className="w-8 shrink-0 text-xs font-medium text-foreground">{option.ratio}</span>
                            <span className="flex-1 whitespace-nowrap text-xs text-muted-foreground">
                              {t(option.labelKey)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="relative shrink-0">
                  <Select
                    value={imageOptions.quality}
                    onChange={(event) => {
                      const quality = event.target.value as AcpImageGenerationOptions['quality'];
                      if (IMAGE_QUALITY_OPTIONS.includes(quality)) updateImageOptions({ quality });
                    }}
                    className="h-8 w-[88px] rounded-lg border-0 bg-black/5 px-2 pr-6 text-xs text-foreground [background-image:none] appearance-none hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
                    data-testid="chat-image-quality"
                    aria-label={t('composer.imageQualityLabel')}
                  >
                    {IMAGE_QUALITY_OPTIONS.map((quality) => (
                      <option key={quality} value={quality}>
                        {formatImageQualityLabel(quality, t)}
                      </option>
                    ))}
                  </Select>
                  <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>
            )}
            </div>

            {/* Send Button — fixed at the right edge. */}
            <Button
              onClick={sending ? handleStop : handleSend}
              disabled={sending ? !canStop : !canSend}
              size="icon"
              data-testid="chat-composer-send"
              className={`shrink-0 self-end h-8 w-8 rounded-lg transition-colors ${
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
        <div className="mt-2.5 flex min-w-0 items-center justify-between gap-2 text-tiny text-muted-foreground/60">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {workspaceLabel && workspacePath && (
              <div ref={workspaceMenuRef} className="relative min-w-0 shrink" onKeyDown={handleWorkspaceKeyDown}>
                <button
                  type="button"
                  data-testid="chat-workspace-selector"
                  title={workspacePath}
                  aria-disabled={workspaceSelectorDisabled ? 'true' : undefined}
                  aria-expanded={!workspaceSelectorDisabled ? workspaceMenuOpen : undefined}
                  tabIndex={workspaceSelectorDisabled ? -1 : undefined}
                  onClick={workspaceSelectorDisabled ? undefined : handleWorkspaceButtonClick}
                  className={cn(
                    'inline-flex min-w-0 max-w-[260px] items-center gap-1 rounded-full border px-2 py-0.5',
                    'bg-black/[0.02] text-tiny font-medium text-foreground/75 transition-colors dark:bg-white/[0.04]',
                    workspaceSelectorDisabled
                      ? 'cursor-default border-transparent opacity-80'
                      : 'border-black/10 hover:bg-black/5 hover:text-foreground dark:border-white/10 dark:hover:bg-white/10',
                  )}
                >
                  <FolderOpen className="h-3 w-3 shrink-0" />
                  <span className="min-w-0 truncate">
                    {t('composer.workspacePrefix', { workspace: workspaceLabel })}
                  </span>
                  {!workspaceSelectorDisabled && (
                    <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', workspaceMenuOpen && 'rotate-180')} />
                  )}
                </button>
                {workspaceMenuOpen && !workspaceSelectorDisabled && (
                  <div
                    data-testid="chat-workspace-menu"
                    className="absolute bottom-full left-0 z-20 mb-2 max-h-80 w-64 overflow-y-auto rounded-2xl border border-black/10 bg-surface-modal p-1.5 shadow-xl dark:border-white/10"
                  >
                    <button
                      type="button"
                      data-testid="chat-workspace-default"
                      aria-current={isDefaultWorkspacePath(workspacePath) ? 'true' : undefined}
                      onClick={handleSelectDefaultWorkspace}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10',
                        isDefaultWorkspacePath(workspacePath) && 'bg-black/5 dark:bg-white/10',
                      )}
                    >
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{t('composer.defaultWorkspaceOption')}</span>
                      {isDefaultWorkspacePath(workspacePath) && <Check className="h-3.5 w-3.5 shrink-0" />}
                    </button>
                    {workspaceOptions.map((option) => {
                      const optionPath = normalizeWorkspacePath(option.path);
                      if (!optionPath || isDefaultWorkspacePath(optionPath)) return null;
                      const selected = optionPath === normalizeWorkspacePath(workspacePath);
                      return (
                        <button
                          key={optionPath}
                          type="button"
                          data-testid={`chat-workspace-option-${encodeURIComponent(optionPath)}`}
                          title={optionPath}
                          aria-current={selected ? 'true' : undefined}
                          onClick={() => handleSelectWorkspace(optionPath)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10',
                            selected && 'bg-black/5 dark:bg-white/10',
                          )}
                        >
                          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">{option.label}</span>
                          {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                        </button>
                      );
                    })}
                    <div className="my-1 border-t border-black/5 dark:border-white/10" />
                    <button
                      type="button"
                      data-testid="chat-workspace-choose-other"
                      onClick={() => void handleChooseOtherWorkspace()}
                      className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{t('composer.chooseOtherWorkspaceOption')}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 overflow-hidden text-right">
            <div className="flex min-w-0 items-center justify-end gap-1.5 overflow-hidden">
              <div className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                isGatewayUsable ? 'bg-green-500/80' : 'bg-red-500/80',
              )} />
              <span className="min-w-0 truncate">
                {t('composer.gatewayStatus', {
                  state: isGatewayUsable
                    ? t('composer.gatewayConnected')
                    : gatewayStatus.state === 'running'
                      ? t('composer.gatewayStarting')
                      : gatewayStatus.state,
                  port: gatewayStatus.port,
                  pid: gatewayStatus.pid ?? '',
                })}
              </span>
              {chatComposerStatusComponents.map((Component, index) => (
                <Component key={`${index}`} gatewayStatus={gatewayStatus} />
              ))}
            </div>
            {hasFailedAttachments && (
              <Button
                variant="link"
                size="sm"
                className="h-auto shrink-0 p-0 text-tiny"
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
