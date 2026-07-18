/**
 * Global image generation settings (agents.defaults.imageGenerationModel).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ImagePlus, Loader2, Play, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  clearImageGenerationSettings,
  fetchImageGenerationSettings,
  runImageGenerationTest,
  saveImageGenerationSettings,
  type ImageGenerationSettingsSnapshot,
} from '@/lib/image-generation';
import { cn } from '@/lib/utils';

const inputClasses =
  'h-[44px] rounded-xl font-mono text-meta bg-transparent border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:border-blue-500 shadow-sm transition-all text-foreground placeholder:text-foreground/40';
const labelClasses = 'text-sm text-foreground/80 font-bold';
const IMAGE_GENERATION_MODEL = 'gpt-image-2';

function extractTestOutputPath(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const outputs = (result as { outputs?: unknown }).outputs;
  if (!Array.isArray(outputs) || outputs.length === 0) return null;
  const first = outputs[0];
  if (!first || typeof first !== 'object') return null;
  const pathValue = (first as { path?: unknown }).path;
  return typeof pathValue === 'string' && pathValue.trim() ? pathValue.trim() : null;
}

export function ImageGenerationSettings() {
  const { t } = useTranslation(['dashboard', 'settings', 'common']);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ImageGenerationSettingsSnapshot | null>(null);

  const [relayBaseUrl, setRelayBaseUrl] = useState('');
  const [relayModel, setRelayModel] = useState(IMAGE_GENERATION_MODEL);
  const [testAgentId, setTestAgentId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const settings = await fetchImageGenerationSettings();
      setSnapshot(settings);
      setRelayBaseUrl(settings.openAiRelay?.baseUrl ?? '');
      setRelayModel(IMAGE_GENERATION_MODEL);
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

  const dirty = useMemo(() => {
    if (!snapshot) return false;
    return (
      relayBaseUrl.trim() !== (snapshot.openAiRelay?.baseUrl ?? '').trim()
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
      const next = await saveImageGenerationSettings({
        openAiRelayEnabled: true,
        openAiRelayBaseUrl: relayBaseUrl.trim(),
        openAiRelayModel: IMAGE_GENERATION_MODEL,
      });
      setSnapshot(next);
      setRelayBaseUrl(next.openAiRelay?.baseUrl ?? '');
      setRelayModel(IMAGE_GENERATION_MODEL);
      toast.success(t('imageGeneration.toast.saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    try {
      const next = await clearImageGenerationSettings();
      setSnapshot(next);
      setRelayBaseUrl('');
      setRelayModel(IMAGE_GENERATION_MODEL);
      setClearConfirmOpen(false);
      toast.success(t('imageGeneration.toast.cleared'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setClearing(false);
    }
  };

  const handleTest = async () => {
    if (dirty) {
      toast.message(t('imageGeneration.toast.saveBeforeTest'));
      return;
    }
    if (!hasConfiguredRelay) {
      return;
    }
    setTesting(true);
    try {
      const result = await runImageGenerationTest({
        agentId: testAgentId || snapshot?.defaultAgentId,
        prompt: t('imageGeneration.testPrompt'),
      });
      if (result.success) {
        const outputPath = extractTestOutputPath(result.result);
        if (outputPath) {
          toast.success(t('imageGeneration.toast.testSuccessWithPath', {
            ms: Math.round(result.durationMs),
            path: outputPath,
          }));
        } else {
          toast.success(t('imageGeneration.toast.testSuccess', { ms: Math.round(result.durationMs) }));
        }
      } else {
        toast.error(result.error || result.stderr || t('imageGeneration.toast.testFailed'));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div data-testid="image-generation-settings" className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            data-testid="image-generation-settings-title"
            className="text-3xl font-serif text-foreground font-normal tracking-tight flex items-center gap-2"
          >
            <ImagePlus className="h-7 w-7 text-foreground/70" />
            {t('imageGeneration.title')}
          </h2>
          <p className="text-meta text-muted-foreground mt-2 max-w-2xl">
            {t('imageGeneration.description')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="rounded-full shrink-0"
          onClick={() => void load()}
          disabled={loading}
          data-testid="image-generation-refresh"
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
            data-testid="image-generation-openai-relay"
          >
            <div>
              <Label className={labelClasses}>{t('imageGeneration.openAiRelay.title')}</Label>
              <p className="text-meta text-muted-foreground mt-1">
                {t('imageGeneration.openAiRelay.description')}
              </p>
            </div>

            <div className="space-y-4 pt-1">
                <div className="space-y-2">
                  <Label htmlFor="image-gen-relay-base-url" className={labelClasses}>
                    {t('imageGeneration.openAiRelay.baseUrl')}
                  </Label>
                  <Input
                    id="image-gen-relay-base-url"
                    value={relayBaseUrl}
                    readOnly
                    className={inputClasses}
                    data-testid="image-generation-relay-base-url"
                  />
                  <p className="text-tiny text-muted-foreground">
                    {t('imageGeneration.openAiRelay.baseUrlHint')}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="image-gen-relay-model" className={labelClasses}>
                    {t('imageGeneration.openAiRelay.model')}
                  </Label>
                  <Input
                    id="image-gen-relay-model"
                    value={relayModel}
                    readOnly
                    placeholder={IMAGE_GENERATION_MODEL}
                    className={inputClasses}
                    data-testid="image-generation-relay-model"
                  />
                  <p className="text-tiny text-muted-foreground">
                    {t('imageGeneration.openAiRelay.modelHint')}
                  </p>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <Label className={labelClasses}>
                        {t('imageGeneration.openAiRelay.apiKey')}
                      </Label>
                      <p className="text-xs text-muted-foreground" data-testid="image-generation-api-key-status">
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
                    id="image-gen-relay-api-key"
                    readOnly
                    value=""
                    placeholder={t('imageGeneration.openAiRelay.apiKeyInherited')}
                    className={cn(inputClasses, 'pr-10')}
                    autoComplete="off"
                    data-testid="image-generation-relay-api-key"
                  />
                  <p className="text-xs text-muted-foreground" data-testid="image-generation-api-key-help">
                    {t('imageGeneration.openAiRelay.apiKeyInheritedHelp')}
                  </p>
                </div>
            </div>
          </div>

          <div className="space-y-3">
            <Label className={labelClasses}>{t('imageGeneration.agentAuthTitle')}</Label>
            <p className="text-meta text-muted-foreground">{t('imageGeneration.agentAuthDesc')}</p>
            <div className="rounded-2xl border border-black/10 dark:border-white/10 overflow-hidden">
              <table className="w-full text-sm" data-testid="image-generation-agent-auth-table">
                <thead>
                  <tr className="border-b border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 text-left text-meta text-muted-foreground">
                    <th className="px-4 py-2 font-medium">{t('imageGeneration.agentColumn')}</th>
                    <th className="px-4 py-2 font-medium">{t('imageGeneration.authColumn')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot?.agents ?? []).map((agent) => (
                    <tr
                      key={agent.id}
                      className="border-b border-black/5 dark:border-white/5 last:border-0"
                      data-testid={`image-generation-agent-row-${agent.id}`}
                    >
                      <td className="px-4 py-3">
                        <span className="font-medium">{agent.name}</span>
                        {agent.isDefault ? (
                          <Badge variant="outline" className="ml-2 rounded-full text-2xs">
                            {t('imageGeneration.defaultAgent')}
                          </Badge>
                        ) : null}
                        <span className="block font-mono text-tiny text-muted-foreground mt-0.5">{agent.id}</span>
                      </td>
                      <td className="px-4 py-3">
                        {agent.provider ? (
                          agent.configured ? (
                            <Badge className="rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15">
                              {t('imageGeneration.authConfigured')}
                            </Badge>
                          ) : (
                            <Badge variant="destructive" className="rounded-full">
                              {t('imageGeneration.authMissing')}
                            </Badge>
                          )
                        ) : (
                          <span className="text-muted-foreground">—</span>
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
              <Label htmlFor="image-gen-test-agent" className={labelClasses}>
                {t('imageGeneration.testAgent')}
              </Label>
              <select
                id="image-gen-test-agent"
                value={testAgentId}
                onChange={(e) => setTestAgentId(e.target.value)}
                className={cn(inputClasses, 'w-full')}
                data-testid="image-generation-test-agent"
              >
                {(snapshot?.agents ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                    {agent.isDefault ? ` (${t('imageGeneration.defaultAgent')})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <Button
              variant="outline"
              className="rounded-full h-10"
              onClick={() => void handleTest()}
              disabled={testing || !hasConfiguredRelay || dirty}
              data-testid="image-generation-test-button"
            >
              {testing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-2" />
              )}
              {testing ? t('imageGeneration.testing') : t('imageGeneration.testButton')}
            </Button>
            <Button
              className="rounded-full h-10"
              onClick={() => void handleSave()}
              disabled={saving || !dirty}
              data-testid="image-generation-save"
            >
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              {saving ? t('imageGeneration.saving') : t('imageGeneration.save')}
            </Button>
            <Button
              variant="outline"
              className="rounded-full h-10 text-destructive hover:text-destructive"
              onClick={() => setClearConfirmOpen(true)}
              disabled={clearing || !hasConfiguredRelay}
              data-testid="image-generation-clear"
            >
              {clearing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-2" />
              )}
              {clearing ? t('imageGeneration.clearing') : t('imageGeneration.clear')}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={clearConfirmOpen}
        title={t('imageGeneration.clearConfirmTitle')}
        message={t('imageGeneration.clearConfirmMessage')}
        confirmLabel={t('imageGeneration.clearConfirmAction')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={handleClear}
        onCancel={() => setClearConfirmOpen(false)}
      />
    </div>
  );
}
