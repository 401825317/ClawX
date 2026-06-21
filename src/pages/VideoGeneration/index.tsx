import { VideoGenerationSettings } from '@/components/settings/VideoGenerationSettings';

export function VideoGenerationPage() {
  return (
    <div data-testid="video-generation-page" className="flex flex-col -m-6 dark:bg-background min-h-[calc(100vh-2.5rem)] overflow-hidden">
      <div className="w-full max-w-5xl mx-auto flex flex-col h-full p-10 pt-16">
        <VideoGenerationSettings />
      </div>
    </div>
  );
}

export default VideoGenerationPage;
