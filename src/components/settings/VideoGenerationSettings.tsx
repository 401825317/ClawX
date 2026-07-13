/**
 * Global video generation settings (agents.defaults.videoGenerationModel).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Play, RefreshCw, Trash2, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  clearVideoGenerationSettings,
  fetchVideoGenerationSettings,
  runVideoGenerationTest,
  saveVideoGenerationSettings,
  type VideoGenerationModelOption,
  type VideoGenerationSettingsSnapshot,
} from '@/lib/video-generation';
import { cn } from '@/lib/utils';

const inputClasses =
  'h-[44px] rounded-xl font-mono text-meta bg-transparent border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:border-blue-500 shadow-sm transition-all text-foreground placeholder:text-foreground/40';
const labelClasses = 'text-sm text-foreground/80 font-bold';

const FALLBACK_MODEL_OPTIONS: VideoGenerationModelOption[] = [
  {
    id: 'grok-image-video',
    label: 'Grok Video',
    description: 'Text or image to video through the current zz-cn backend model.',
    verified: true,
    modes: ['text-to-video', 'image-to-video'],
  },
  {
    id: 'grok-video-1.5',
    label: 'Grok Video 1.5',
    description: 'Alternate Grok video model exposed by the current zz-cn backend.',
    verified: true,
    modes: ['text-to-video', 'image-to-video'],
  },
];

function extractTestOutputLocation(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const outputs = (result as { outputs?: unknown }).outputs;
  if (!Array.isArray(outputs) || outputs.length === 0) return null;
  const first = outputs[0];
  if (!first || typeof first !== 'object') return null;
  const pathValue = (first as { path?: unknown }).path;
  if (typeof pathValue === 'string' && pathValue.trim()) return pathValue.trim();
  const urlValue = (first as { url?: unknown }).url;
  return typeof urlValue === 'string' && urlValue.trim() ? urlValue.trim() : null;
}

export function VideoGenerationSettings() {
  const { t } = useTranslation(['dashboard', 'settings', 'common']);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<VideoGenerationSettingsSnapshot | null>(null);

  const [relayBaseUrl, setRelayBaseUrl] = useState('');
  const [relayModel, setRelayModel] = useState('grok-image-video');
  const [testAgentId, setTestAgentId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const settings = await fetchVideoGenerationSettings();
      setSnapshot(settings);
      setRelayBaseUrl(settings.openAiRelay?.baseUrl ?? '');
      setRelayModel(settings.openAiRelay?.model || 'grok-image-video');
      setTestAgentId(settings.defaultAgentId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const modelOptions = snapshot?.openAiRelay?.modelOptions?.length
    ? snapshot.openAiRelay.modelOptions
    : FALLBACK_MODEL_OPTIONS;

  const selectedModelOption = useMemo(
    () => modelOptions.find((option) => option.id === relayModel) ?? modelOptions[0],
    [modelOptions, relayModel],
  );

  const dirty = useMemo(() => {
    if (!snapshot) return false;
    return (
      relayBaseUrl.trim() !== (snapshot.openAiRelay?.baseUrl ?? '').trim()
      || relayModel.trim() !== (snapshot.openAiRelay?.model ?? '').trim()
    );
  }, [snapshot, relayBaseUrl, relayModel]);

  const hasConfiguredRelay = useMemo(() => {
    if (!snapshot) return false;
    return Boolean(
      snapshot.openAiRelay?.enabled
      || snapshot.openAiRelay?.baseUrl?.trim()
      || snapshot.config.primary?.trim(),
    );
  }, [snapshot]);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (!modelOptions.some((option) => option.id === relayModel.trim())) {
        throw new Error(t('videoGeneration.errors.relayModelRequired', 'Select a video model'));
      }
      const next = await saveVideoGenerationSettings({
        openAiRelayEnabled: true,
        openAiRelayBaseUrl: relayBaseUrl.trim(),
        openAiRelayModel: relayModel.trim(),
      });
      setSnapshot(next);
      setRelayBaseUrl(next.openAiRelay?.baseUrl ?? '');
      setRelayModel(next.openAiRelay?.model || 'grok-image-video');
      toast.success(t('videoGeneration.toast.saved', 'Video generation settings saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    try {
      const next = await clearVideoGenerationSettings();
      setSnapshot(next);
      setRelayBaseUrl('');
      setRelayModel('grok-image-video');
      setClearConfirmOpen(false);
      toast.success(t('videoGeneration.toast.cleared', 'Video generation configuration cleared'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setClearing(false);
    }
  };

  const handleTest = async () => {
    if (dirty) {
      toast.message(t('videoGeneration.toast.saveBeforeTest', 'Save settings before running a test'));
      return;
    }
    if (!hasConfiguredRelay) {
      return;
    }
    setTesting(true);
    try {
      const result = await runVideoGenerationTest({
        agentId: testAgentId || snapshot?.defaultAgentId,
        prompt: t('videoGeneration.testPrompt', 'A cinematic four-second shot of a small red paper airplane gliding over a white desk.'),
      });
      if (result.success) {
        const outputLocation = extractTestOutputLocation(result.result);
        if (outputLocation) {
          toast.success(t('videoGeneration.toast.testSuccessWithPath', {
            defaultValue: 'Test video generated ({{ms}} ms): {{path}}',
            ms: Math.round(result.durationMs),
            path: outputLocation,
          }));
        } else {
          toast.success(t('videoGeneration.toast.testSuccess', {
            defaultValue: 'Test video generated ({{ms}} ms)',
            ms: Math.round(result.durationMs),
          }));
        }
      } else {
        toast.error(result.error || result.stderr || t('videoGeneration.toast.testFailed', 'Video generation test failed'));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div data-testid="video-generation-settings" className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            data-testid="video-generation-settings-title"
            className="text-3xl font-serif text-foreground font-normal tracking-tight flex items-center gap-2"
          >
            <Video className="h-7 w-7 text-foreground/70" />
            {t('videoGeneration.title', 'Video Generation')}
          </h2>
          <p className="text-meta text-muted-foreground mt-2 max-w-2xl">
            {t('videoGeneration.description', 'Video generation uses the current signed-in account and the zz-cn OpenAI-compatible video endpoint. Configure model and timeout here.')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="rounded-full shrink-0"
          onClick={() => void load()}
          disabled={loading}
          data-testid="video-generation-refresh"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground bg-black/5 dark:bg-white/5 rounded-3xl border border-dashed border-transparent">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : (
        <div className="space-y-8 rounded-3xl border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] p-6 md:p-8">
          <div
            className="space-y-4 rounded-2xl border border-black/10 dark:border-white/10 p-5"
            data-testid="video-generation-openai-relay"
          >
            <div>
              <Label className={labelClasses}>
                {t('videoGeneration.openAiRelay.title', 'Video endpoint')}
              </Label>
              <p className="text-meta text-muted-foreground mt-1">
                {t('videoGeneration.openAiRelay.description', 'Requests are sent through the current signed-in account. No separate API key is required here.')}
              </p>
            </div>

            <div className="space-y-4 pt-1">
              <div className="space-y-2">
                <Label htmlFor="video-gen-relay-base-url" className={labelClasses}>
                  {t('videoGeneration.openAiRelay.baseUrl', 'Video Base URL')}
                </Label>
                <Input
                  id="video-gen-relay-base-url"
                  value={relayBaseUrl}
                  readOnly
                  className={inputClasses}
                  data-testid="video-generation-relay-base-url"
                />
                <p className="text-tiny text-muted-foreground">
                  {t('videoGeneration.openAiRelay.baseUrlHint', 'Provided by the current signed-in account.')}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="video-gen-relay-model" className={labelClasses}>
                  {t('videoGeneration.openAiRelay.model', 'Video model')}
                </Label>
                <select
                  id="video-gen-relay-model"
                  value={relayModel}
                  onChange={(e) => setRelayModel(e.target.value)}
                  className={cn(inputClasses, 'w-full')}
                  data-testid="video-generation-relay-model"
                >
                  {modelOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {selectedModelOption ? (
                  <div className="flex flex-wrap items-center gap-2 text-tiny text-muted-foreground">
                    <span>{selectedModelOption.description}</span>
                    {selectedModelOption.verified ? (
                      <Badge variant="outline" className="rounded-full text-2xs">
                        {t('videoGeneration.openAiRelay.recommended', 'recommended')}
                      </Badge>
                    ) : null}
                    <span className="font-mono text-2xs opacity-75">
                      {t('videoGeneration.openAiRelay.modelId', {
                        defaultValue: 'model: {{id}}',
                        id: selectedModelOption.id,
                      })}
                    </span>
                  </div>
                ) : null}
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <Label className={labelClasses}>
                      {t('videoGeneration.openAiRelay.apiKey', 'API key')}
                    </Label>
                    <p className="text-xs text-muted-foreground" data-testid="video-generation-api-key-status">
                      {snapshot?.openAiRelay?.apiKeyConfigured
                        ? t('settings:aiProviders.dialog.apiKeyConfigured')
                        : t('settings:aiProviders.dialog.apiKeyMissing')}
                    </p>
                  </div>
                  {snapshot?.openAiRelay?.apiKeyConfigured ? (
                    <div className="flex items-center gap-1.5 text-tiny font-medium text-green-600 dark:text-green-500 bg-green-500/10 px-2 py-1 rounded-md">
                      <div className="w-1.5 h-1.5 rounded-full bg-current" />
                      {t('settings:aiProviders.card.configured')}
                    </div>
                  ) : null}
                </div>
                <Input
                  id="video-gen-relay-api-key"
                  readOnly
                  value=""
                  placeholder={t('videoGeneration.openAiRelay.apiKeyInherited', 'Inherited from current account')}
                  className={inputClasses}
                  autoComplete="off"
                  data-testid="video-generation-relay-api-key"
                />
                <p className="text-xs text-muted-foreground" data-testid="video-generation-api-key-help">
                  {t('videoGeneration.openAiRelay.apiKeyInheritedHelp', 'Video generation reuses the current signed-in account authentication.')}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <Label className={labelClasses}>
              {t('videoGeneration.agentAuthTitle', 'Per-agent authentication')}
            </Label>
            <p className="text-meta text-muted-foreground">
              {t('videoGeneration.agentAuthDesc', 'Video generation uses auth synced from the current signed-in account for each agent.')}
            </p>
            <div className="rounded-2xl border border-black/10 dark:border-white/10 overflow-hidden">
              <table className="w-full text-sm" data-testid="video-generation-agent-auth-table">
                <thead>
                  <tr className="border-b border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 text-left text-meta text-muted-foreground">
                    <th className="px-4 py-2 font-medium">{t('videoGeneration.agentColumn', 'Agent')}</th>
                    <th className="px-4 py-2 font-medium">{t('videoGeneration.authColumn', 'Video endpoint auth')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot?.agents ?? []).map((agent) => (
                    <tr
                      key={agent.id}
                      className="border-b border-black/5 dark:border-white/5 last:border-0"
                      data-testid={`video-generation-agent-row-${agent.id}`}
                    >
                      <td className="px-4 py-3">
                        <span className="font-medium">{agent.name}</span>
                        {agent.isDefault ? (
                          <Badge variant="outline" className="ml-2 rounded-full text-2xs">
                            {t('videoGeneration.defaultAgent', 'default')}
                          </Badge>
                        ) : null}
                        <span className="block font-mono text-tiny text-muted-foreground mt-0.5">{agent.id}</span>
                      </td>
                      <td className="px-4 py-3">
                        {agent.provider ? (
                          agent.configured ? (
                            <Badge className="rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15">
                              {t('videoGeneration.authConfigured', 'Ready')}
                            </Badge>
                          ) : (
                            <Badge variant="destructive" className="rounded-full">
                              {t('videoGeneration.authMissing', 'Missing key')}
                            </Badge>
                          )
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4 pt-2 border-t border-black/10 dark:border-white/10">
            <div className="space-y-2 min-w-[200px]">
              <Label htmlFor="video-gen-test-agent" className={labelClasses}>
                {t('videoGeneration.testAgent', 'Test as agent')}
              </Label>
              <select
                id="video-gen-test-agent"
                value={testAgentId}
                onChange={(e) => setTestAgentId(e.target.value)}
                className={cn(inputClasses, 'w-full')}
                data-testid="video-generation-test-agent"
              >
                {(snapshot?.agents ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                    {agent.isDefault ? ` (${t('videoGeneration.defaultAgent', 'default')})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <Button
              variant="outline"
              className="rounded-full h-10"
              onClick={() => void handleTest()}
              disabled={testing || !hasConfiguredRelay || dirty}
              data-testid="video-generation-test-button"
            >
              {testing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-2" />
              )}
              {testing
                ? t('videoGeneration.testing', 'Generating...')
                : t('videoGeneration.testButton', 'Test generate')}
            </Button>
            <Button
              className="rounded-full h-10"
              onClick={() => void handleSave()}
              disabled={saving || !dirty}
              data-testid="video-generation-save"
            >
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              {saving ? t('videoGeneration.saving', 'Saving...') : t('videoGeneration.save', 'Save')}
            </Button>
            <Button
              variant="outline"
              className="rounded-full h-10 text-destructive hover:text-destructive"
              onClick={() => setClearConfirmOpen(true)}
              disabled={clearing || !hasConfiguredRelay}
              data-testid="video-generation-clear"
            >
              {clearing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-2" />
              )}
              {clearing
                ? t('videoGeneration.clearing', 'Clearing...')
                : t('videoGeneration.clear', 'Clear configuration')}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={clearConfirmOpen}
        title={t('videoGeneration.clearConfirmTitle', 'Clear video generation configuration?')}
        message={t('videoGeneration.clearConfirmMessage', 'This removes the custom video endpoint and model selection. Chat providers are not otherwise changed.')}
        confirmLabel={t('videoGeneration.clearConfirmAction', 'Clear')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={handleClear}
        onCancel={() => setClearConfirmOpen(false)}
      />
    </div>
  );
}
