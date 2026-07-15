import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

export const TimelineMarkdown = memo(function TimelineMarkdown({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <div className="prose prose-sm max-w-none break-words text-foreground dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
