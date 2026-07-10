import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatMessage } from '@/pages/Chat/ChatMessage';
import type { RawMessage } from '@/stores/chat';
import { invokeIpc } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(),
  readBinaryFile: vi.fn(),
  statFile: vi.fn(async (path: string) => {
    if (path.includes('missing') || path.includes('不存在')) {
      return { ok: false, error: 'notFound' };
    }
    const isFile = /\.[A-Za-z0-9]+$/.test(path);
    return {
      ok: true,
      isFile,
      isDir: !isFile,
      size: isFile ? 1024 : 0,
    };
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'artifactManifest.title': '产物清单',
        'artifactManifest.completed': '已完成',
        'artifactManifest.failed': '失败',
        'artifactManifest.blocked': '待补充',
        'artifactManifest.noArtifact': '未生成产物',
        'artifactManifest.playable': '可播放',
        'artifactManifest.videoLink': '视频链接',
        'artifactManifest.generated': '已生成',
        'artifactManifest.types.image': '图片',
        'artifactManifest.types.video': '视频',
        'artifactManifest.types.presentation': 'PPT',
        'artifactManifest.types.spreadsheet': 'Excel',
        'artifactManifest.types.miniProgram': '网页',
        'artifactManifest.types.copywriting': '文案',
        'artifactManifest.types.file': '文件',
      };
      if (key === 'artifactManifest.count') return `${Number(options?.count ?? 0)} 个`;
      return translations[key] ?? key;
    },
  }),
}));

describe('ChatMessage attachment dedupe', () => {
  it('renders one file card when the same attachment path is present twice', () => {
    const file = {
      fileName: '建筑工程投标标书-PPT-20260707-070535-57b40329.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      fileSize: 31393,
      preview: null,
      filePath: '/Users/me/Downloads/UClaw/建筑工程投标标书-PPT-20260707-070535-57b40329.pptx',
      source: 'tool-result' as const,
    };
    const message: RawMessage = {
      role: 'assistant',
      content: '已完成并打开了建筑工程投标标书 PPT。',
      _attachedFiles: [
        file,
        { ...file, source: 'message-ref' as const, fileSize: 0 },
      ],
    };

    render(<ChatMessage message={message} />);

    expect(screen.getAllByText(file.fileName)).toHaveLength(1);
  });

  it('renders composite results as a compact artifact manifest instead of full media cards', () => {
    const message: RawMessage = {
      role: 'assistant',
      id: 'composite-result:run-1',
      content: '好，我给你做了一套随机示例包。\n\n下面是统一产物清单。',
      _attachedFiles: [
        {
          fileName: 'future-workbench.png',
          mimeType: 'image/png',
          fileSize: 2048,
          preview: null,
          filePath: '/tmp/future-workbench.png',
          source: 'tool-result',
        },
        {
          fileName: 'AI_工作流效率提升.pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          fileSize: 4096,
          preview: null,
          filePath: '/tmp/AI_工作流效率提升.pptx',
          source: 'tool-result',
        },
        {
          fileName: 'future-workbench.mp4',
          mimeType: 'video/mp4',
          fileSize: 0,
          preview: null,
          gatewayUrl: 'https://example.com/future-workbench.mp4',
          source: 'tool-result',
        },
      ],
    };

    render(<ChatMessage message={message} />);

    expect(screen.getByText('产物清单')).toBeInTheDocument();
    expect(screen.getByText('3 个')).toBeInTheDocument();
    expect(screen.getByText('future-workbench.png')).toBeInTheDocument();
    expect(screen.getByText('AI_工作流效率提升.pptx')).toBeInTheDocument();
    expect(screen.getByText('future-workbench.mp4')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-image-preview-card')).not.toBeInTheDocument();
  });

  it('renders persisted composite history replies as a compact artifact manifest', () => {
    const message: RawMessage = {
      role: 'assistant',
      id: 'composite-result:run-persisted',
      localArtifactResultKind: 'composite',
      content: [
        '好，我给你做了一套随机示例包，主题统一成“未来城市里的个人效率工作台”。',
        '',
        '下面是统一产物清单；我也做了基础验证，已生成的本地文件和媒体都可以打开或预览。',
      ].join('\n'),
      _attachedFiles: [
        {
          fileName: 'future-workbench.png',
          mimeType: 'image/png',
          fileSize: 2048,
          preview: null,
          filePath: '/tmp/future-workbench.png',
          source: 'message-ref',
        },
        {
          fileName: 'AI_工作流效率提升.pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          fileSize: 4096,
          preview: null,
          filePath: '/tmp/AI_工作流效率提升.pptx',
          source: 'message-ref',
        },
      ],
    };

    render(<ChatMessage message={message} />);

    expect(screen.getByText('产物清单')).toBeInTheDocument();
    expect(screen.getByText('2 个')).toBeInTheDocument();
    expect(screen.getByText('future-workbench.png')).toBeInTheDocument();
    expect(screen.getByText('AI_工作流效率提升.pptx')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-image-preview-card')).not.toBeInTheDocument();
    expect(screen.queryByText(/MEDIA:/)).not.toBeInTheDocument();
  });

  it('keeps attachment-only assistant replies visible even when process attachments are suppressed', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [],
      _attachedFiles: [
        {
          fileName: 'artifact.png',
          mimeType: 'image/png',
          fileSize: 0,
          preview: '/tmp/artifact.png',
          filePath: '/tmp/artifact.png',
          source: 'tool-result',
        },
      ],
    };

    render(
      <ChatMessage
        message={message}
        suppressProcessAttachments
      />,
    );

    expect(screen.getByAltText('artifact.png')).toBeInTheDocument();
  });

  it('keeps image artifacts visible alongside reply text when process attachments are suppressed', () => {
    // Regression for media outgoing being silently dropped when the agent
    // accompanies a `MEDIA:/path.png` artifact with any narration text:
    // process-attachment filtering used to require PDF/XLSX/dir/skill but
    // had no carve-out for images, so the file card never rendered.
    const message: RawMessage = {
      role: 'assistant',
      content: 'Screenshot taken, sending it to you as an attachment.',
      _attachedFiles: [
        {
          fileName: 'desktop_screenshot.png',
          mimeType: 'image/png',
          fileSize: 1234,
          preview: 'data:image/png;base64,abc',
          filePath: '/tmp/desktop_screenshot.png',
          source: 'tool-result',
        },
      ],
    };

    render(
      <ChatMessage
        message={message}
        suppressProcessAttachments
      />,
    );

    expect(screen.getByAltText('desktop_screenshot.png')).toBeInTheDocument();
  });

  it('opens file-backed image previews from the original file instead of the thumbnail data URL', async () => {
    const { readBinaryFile } = await import('@/lib/api-client');
    const originalBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    vi.mocked(readBinaryFile).mockResolvedValueOnce({
      ok: true,
      data: originalBytes,
      mimeType: 'image/png',
      size: originalBytes.length,
      readOnly: true,
    });
    const message: RawMessage = {
      role: 'assistant',
      content: 'Image generated.',
      _attachedFiles: [
        {
          fileName: 'generated.png',
          mimeType: 'image/png',
          fileSize: 1234,
          preview: 'data:image/png;base64,thumbnail',
          filePath: '/tmp/generated.png',
          source: 'tool-result',
        },
      ],
    };

    render(<ChatMessage message={message} />);
    fireEvent.click(screen.getByTestId('chat-image-preview-card'));

    await waitFor(() => {
      expect(readBinaryFile).toHaveBeenCalledWith('/tmp/generated.png');
      const openedImages = screen.getAllByAltText('generated.png') as HTMLImageElement[];
      expect(openedImages.some((image) => image.src.startsWith('blob:'))).toBe(true);
    });
  });

  it('keeps assistant image cards aligned to their natural height in mixed-aspect rows', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'Images generated.',
      _attachedFiles: [
        {
          fileName: 'portrait.png',
          mimeType: 'image/png',
          fileSize: 1234,
          preview: 'data:image/png;base64,portrait',
          filePath: '/tmp/portrait.png',
          source: 'tool-result',
        },
        {
          fileName: 'wide.png',
          mimeType: 'image/png',
          fileSize: 1234,
          preview: 'data:image/png;base64,wide',
          filePath: '/tmp/wide.png',
          width: 1536,
          height: 864,
          source: 'tool-result',
        },
      ],
    };

    render(<ChatMessage message={message} />);

    const cards = screen.getAllByTestId('chat-image-preview-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveClass('self-start');
    expect(cards[1]).toHaveClass('self-start');
    expect(cards[0]?.parentElement).toHaveClass('items-start');
    expect(screen.getByAltText('wide.png')).toHaveAttribute('width', '1536');
    expect(screen.getByAltText('wide.png')).toHaveAttribute('height', '864');
  });

  it('lets a file-backed image be selected as an edit reference', () => {
    const file = {
      fileName: 'generated.png',
      mimeType: 'image/png',
      fileSize: 1234,
      preview: 'data:image/png;base64,abc',
      filePath: '/tmp/generated.png',
      source: 'tool-result' as const,
    };
    const onUseImageAsReference = vi.fn();
    const message: RawMessage = {
      role: 'assistant',
      content: 'Image generated.',
      _attachedFiles: [file],
    };

    render(
      <ChatMessage
        message={message}
        onUseImageAsReference={onUseImageAsReference}
      />,
    );

    fireEvent.click(screen.getByTestId('image-edit-reference-button'));

    expect(onUseImageAsReference).toHaveBeenCalledWith(file);
  });

  it('keeps the edit reference button when an image content block hides the duplicate attachment card', () => {
    const file = {
      fileName: 'generated.png',
      mimeType: 'image/png',
      fileSize: 1234,
      preview: 'data:image/png;base64,abc',
      filePath: '/tmp/generated.png',
      source: 'gateway-media' as const,
    };
    const onUseImageAsReference = vi.fn();
    const message: RawMessage = {
      role: 'assistant',
      content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }],
      _attachedFiles: [file],
    };

    render(
      <ChatMessage
        message={message}
        onUseImageAsReference={onUseImageAsReference}
      />,
    );

    fireEvent.click(screen.getByTestId('image-edit-reference-button'));

    expect(onUseImageAsReference).toHaveBeenCalledWith(file);
  });

  it('shows an explicit loading state for image artifacts before preview hydration finishes', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'Image generated.',
      _attachedFiles: [
        {
          fileName: 'generated.png',
          mimeType: 'image/png',
          fileSize: 0,
          preview: null,
          gatewayUrl: '/api/chat/media/outgoing/agent%3Amain%3As-1/generated/full',
          source: 'gateway-media',
        },
      ],
    };

    render(<ChatMessage message={message} />);

    expect(screen.getByTestId('image-preview-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('image-preview-unavailable')).not.toBeInTheDocument();
  });

  it('shows an unavailable state after image preview hydration gives up', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'Image generated.',
      _attachedFiles: [
        {
          fileName: 'generated.png',
          mimeType: 'image/png',
          fileSize: 0,
          preview: null,
          previewStatus: 'unavailable',
          gatewayUrl: '/api/chat/media/outgoing/agent%3Amain%3As-1/generated/full',
          source: 'gateway-media',
        },
      ],
    };

    render(<ChatMessage message={message} />);

    expect(screen.getByTestId('image-preview-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('image-preview-loading')).not.toBeInTheDocument();
  });

  it('keeps message-ref image artifacts visible alongside reply text when process attachments are suppressed', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'Compressed, sending it to you:',
      _attachedFiles: [
        {
          fileName: 'desktop_screenshot.jpg',
          mimeType: 'image/jpeg',
          fileSize: 837_000,
          preview: 'data:image/jpeg;base64,xyz',
          filePath: '/tmp/desktop_screenshot.jpg',
          source: 'message-ref',
        },
      ],
    };

    render(
      <ChatMessage
        message={message}
        suppressProcessAttachments
      />,
    );

    expect(screen.getByAltText('desktop_screenshot.jpg')).toBeInTheDocument();
  });

  it('keeps html artifacts visible when process attachments are suppressed', async () => {
    const message: RawMessage = {
      role: 'assistant',
      content: '已生成 /workspace/demo.html',
    };

    render(<ChatMessage message={message} suppressProcessAttachments />);

    expect(await screen.findByText('demo.html')).toBeInTheDocument();
  });

  it('hides generic tool-result markdown attachments when process attachments are suppressed', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'Coder has finished the analysis, here are the conclusions.',
      _attachedFiles: [
        {
          fileName: 'CHECKLIST.md',
          mimeType: 'text/markdown',
          fileSize: 433,
          preview: null,
          filePath: '/Users/bytedance/.openclaw/workspace/CHECKLIST.md',
          source: 'tool-result',
        },
      ],
    };

    render(<ChatMessage message={message} suppressProcessAttachments />);

    expect(screen.getByText('Coder has finished the analysis, here are the conclusions.')).toBeInTheDocument();
    expect(screen.queryByText('CHECKLIST.md')).not.toBeInTheDocument();
  });

  it('keeps attached SKILL.md visible when process attachments are suppressed', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: '这是文件。',
      _attachedFiles: [
        {
          fileName: 'SKILL.md',
          mimeType: 'text/markdown',
          fileSize: 128,
          preview: null,
          filePath: '/workspace/skills/open-xueqiu/SKILL.md',
          source: 'tool-result',
        },
      ],
    };

    render(<ChatMessage message={message} suppressProcessAttachments />);

    expect(screen.getByText('SKILL.md')).toBeInTheDocument();
  });

  it('keeps pdf and spreadsheet artifacts visible when process attachments are suppressed', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'Here are the generated files.',
      _attachedFiles: [
        {
          fileName: 'sales.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileSize: 1024,
          preview: null,
          filePath: '/tmp/sales.xlsx',
          source: 'message-ref',
        },
        {
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
          fileSize: 2048,
          preview: null,
          filePath: '/tmp/report.pdf',
          source: 'tool-result',
        },
      ],
    };

    render(
      <ChatMessage
        message={message}
        suppressProcessAttachments
      />,
    );

    expect(screen.getByText('sales.xlsx')).toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
  });

  it('derives preview cards from assistant text paths when attachments are missing', async () => {
    const message: RawMessage = {
      role: 'assistant',
      content: '已生成测试 PDF 文件： 测试PDF文件.pdf 位置： `/Users/zhonghaolu/.openclaw/workspace/测试PDF文件.pdf`',
    };

    render(<ChatMessage message={message} suppressProcessAttachments />);

    expect(await screen.findByText('测试PDF文件.pdf')).toBeInTheDocument();
  });

  it('derives PPTX cards from MEDIA tags when attachment enrichment is missing', async () => {
    const message: RawMessage = {
      role: 'assistant',
      content: '已生成好了。\n\nMEDIA:/Users/huajing002/.openclaw/workspace/outputs/iPhone18_概念宣传PPT_20260708_184350_lr15rt.pptx',
    };

    render(<ChatMessage message={message} suppressProcessAttachments />);

    expect(await screen.findByText('iPhone18_概念宣传PPT_20260708_184350_lr15rt.pptx')).toBeInTheDocument();
  });

  it('derives skill directory cards from assistant text paths', async () => {
    const message: RawMessage = {
      role: 'assistant',
      content: '名称： open-eastmoney\n位置： ~/.openclaw/skills/open-eastmoney\n校验结果：通过',
    };

    render(<ChatMessage message={message} suppressProcessAttachments />);

    expect(await screen.findByText('open-eastmoney')).toBeInTheDocument();
    expect(screen.getByText('文件夹')).toBeInTheDocument();
  });

  it('keeps unicode Windows skill directory paths as cards', async () => {
    const message: RawMessage = {
      role: 'assistant',
      content: String.raw`位置： C:\Users\张三\.openclaw\skills\打开东方财富`,
    };

    render(<ChatMessage message={message} suppressProcessAttachments />);

    expect(await screen.findByText('打开东方财富')).toBeInTheDocument();
    expect(screen.getByText('文件夹')).toBeInTheDocument();
  });

  it('shows SKILL.md as a previewable file card instead of a folder', async () => {
    const onOpenFile = vi.fn();
    const message: RawMessage = {
      role: 'assistant',
      content: '位置： ~/.openclaw/skills/open-baidu\nMarkdown 文件： ~/.openclaw/skills/open-baidu/SKILL.md',
    };

    render(<ChatMessage message={message} suppressProcessAttachments onOpenFile={onOpenFile} />);

    expect(await screen.findByText('open-baidu')).toBeInTheDocument();
    expect(await screen.findByText('SKILL.md')).toBeInTheDocument();
    expect(screen.getAllByText('文件夹')).toHaveLength(1);

    fireEvent.click(screen.getByText('SKILL.md'));
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({
      fileName: 'SKILL.md',
      filePath: '~/.openclaw/skills/open-baidu/SKILL.md',
      mimeType: 'text/markdown',
    }));
  });

  it('does not show cards for hallucinated missing paths', async () => {
    const message: RawMessage = {
      role: 'assistant',
      content: '不存在的文件： ~/.openclaw/skills/missing-skill/SKILL.md',
    };

    render(<ChatMessage message={message} suppressProcessAttachments />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('SKILL.md')).not.toBeInTheDocument();
  });

  it('continues hiding non-preview process attachments when process attachments are suppressed', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'I also used a temporary file.',
      _attachedFiles: [
        {
          fileName: 'debug.log',
          mimeType: 'text/plain',
          fileSize: 1024,
          preview: null,
          filePath: '/tmp/debug.log',
          source: 'message-ref',
        },
      ],
    };

    render(
      <ChatMessage
        message={message}
        suppressProcessAttachments
      />,
    );

    expect(screen.queryByText('debug.log')).not.toBeInTheDocument();
  });

  it('renders remote video MEDIA refs through the authenticated Host API media proxy', async () => {
    vi.mocked(invokeIpc).mockResolvedValueOnce('host-token-1');
    const url = 'https://video.junfeiai.hk-proxy.lingzhiwuxian.com/video/grok/task_demo?exp=1782115630&sig=abc123';
    const message: RawMessage = {
      role: 'assistant',
      content: 'Video generated.',
      _attachedFiles: [
        {
          fileName: 'task_demo.mp4',
          mimeType: 'video/mp4',
          fileSize: 0,
          preview: null,
          filePath: url,
          source: 'message-ref',
        },
      ],
    };

    const { container } = render(
      <ChatMessage
        message={message}
        suppressProcessAttachments
      />,
    );

    await waitFor(() => {
      const video = container.querySelector('video');
      expect(video).not.toBeNull();
      const src = video?.getAttribute('src') || '';
      expect(src).toContain('http://127.0.0.1:13210/api/files/remote-media?');
      expect(src).toContain(`url=${encodeURIComponent(url)}`);
      expect(src).toContain('mimeType=video%2Fmp4');
      expect(src).toContain('token=host-token-1');
    });
    expect(screen.getByText('task_demo.mp4')).toBeInTheDocument();
  });

  it('renders local video files through the authenticated Host API media route', async () => {
    vi.mocked(invokeIpc).mockResolvedValueOnce('host-token-1');
    const filePath = '/Users/me/.openclaw/media/tool-video-generation/demo.mp4';
    const message: RawMessage = {
      role: 'assistant',
      content: 'Video generated.',
      _attachedFiles: [
        {
          fileName: 'demo.mp4',
          mimeType: 'video/mp4',
          fileSize: 4096,
          preview: null,
          filePath,
          source: 'tool-result',
        },
      ],
    };

    const { container } = render(
      <ChatMessage
        message={message}
        suppressProcessAttachments
      />,
    );

    await waitFor(() => {
      const src = container.querySelector('video')?.getAttribute('src') || '';
      expect(src).toContain('http://127.0.0.1:13210/api/files/local-media?');
      expect(src).toContain(`path=${encodeURIComponent(filePath)}`);
      expect(src).toContain('token=host-token-1');
    });
  });
});

describe('ChatMessage LaTeX rendering', () => {
  it('renders inline `$...$` math with KaTeX', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'Mass-energy equivalence: $E=mc^2$ is famous.',
    };
    const { container } = render(<ChatMessage message={message} />);
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('renders display `$$...$$` math as a block', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'Definite integral:\n\n$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$\n',
    };
    const { container } = render(<ChatMessage message={message} />);
    expect(container.querySelector('.katex-display')).not.toBeNull();
  });

  it('renders `\\(...\\)` inline math (OpenAI-style escaping)', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'Quadratic formula: \\(x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\\).',
    };
    const { container } = render(<ChatMessage message={message} />);
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('.katex-display')).toBeNull();
  });

  it('renders `\\[...\\]` block math (OpenAI-style escaping)', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'Sum formula:\n\n\\[\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\\]',
    };
    const { container } = render(<ChatMessage message={message} />);
    expect(container.querySelector('.katex-display')).not.toBeNull();
  });

  it('does not rewrite `\\(` inside code fences', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'Code sample:\n\n```\nprintf("\\(hello\\)")\n```\n',
    };
    const { container } = render(<ChatMessage message={message} />);
    expect(container.textContent).toContain('\\(hello\\)');
    expect(container.querySelector('.katex')).toBeNull();
  });
});

describe('ChatMessage word wrapping', () => {
  // Regression for #931: word-break:break-all on the message bubble wrappers
  // forced English words to split mid-character. Long unbreakable tokens
  // (URLs, identifiers) still wrap via overflow-wrap:break-word; inline
  // <code> and <a> children keep break-all because those carry non-prose
  // tokens where mid-char breaks are still desirable.
  it('does not apply break-all to the assistant prose wrapper', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'The neural network response should wrap at word boundaries.',
    };
    const { container } = render(<ChatMessage message={message} />);
    const prose = container.querySelector('.prose');
    expect(prose).not.toBeNull();
    expect(prose?.classList.contains('break-all')).toBe(false);
    expect(prose?.classList.contains('break-words')).toBe(true);
  });

  it('does not apply break-all to user message text', () => {
    const message: RawMessage = {
      role: 'user',
      content: 'A user-typed sentence that should also wrap by words, not characters.',
    };
    const { container } = render(<ChatMessage message={message} />);
    const paragraph = container.querySelector('p.whitespace-pre-wrap');
    expect(paragraph).not.toBeNull();
    expect(paragraph?.classList.contains('break-all')).toBe(false);
    expect(paragraph?.classList.contains('break-words')).toBe(true);
  });

  it('keeps break-all on inline code so long identifiers can still break mid-token', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'Use `someVeryLongIdentifierNameThatShouldStillBreakAnywhere` here.',
    };
    const { container } = render(<ChatMessage message={message} />);
    const inlineCode = container.querySelector('.prose code');
    expect(inlineCode).not.toBeNull();
    expect(inlineCode?.classList.contains('break-all')).toBe(true);
  });

  // Regression: fenced code blocks used to set only `overflow-x-auto`, which
  // hid long log lines / paths behind a horizontal scroll that the chat
  // viewport often clipped. Long lines must now wrap inside the bubble.
  it('wraps fenced code block contents instead of overflowing horizontally', () => {
    const longLine = 'config change requires channel reload (wecom) — deferring until 2 operation(s), 1 reply(ies), 1 embedded run(s) complete';
    const message: RawMessage = {
      role: 'assistant',
      content: ['Gateway log:', '', '```', longLine, '```'].join('\n'),
    };
    const { container } = render(<ChatMessage message={message} />);
    const codeBlock = container.querySelector('.prose pre');
    expect(codeBlock).not.toBeNull();
    expect(codeBlock?.classList.contains('whitespace-pre-wrap')).toBe(true);
    expect(codeBlock?.classList.contains('break-words')).toBe(true);
  });
});

describe('ChatMessage reply styling', () => {
  it('renders assistant replies as plain Markdown without a rounded bubble wrapper', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'Direct Markdown reply with **bold** text.',
    };

    const { container } = render(<ChatMessage message={message} />);
    const prose = container.querySelector('.prose');
    expect(prose).not.toBeNull();
    expect(prose?.classList.contains('rounded-2xl')).toBe(false);
    expect(prose?.classList.contains('bg-black/5')).toBe(false);
    expect(prose?.classList.contains('dark:bg-white/5')).toBe(false);
    expect(prose?.parentElement?.classList.contains('rounded-2xl')).toBe(false);
  });

  it('keeps user messages in the blue rounded bubble', () => {
    const message: RawMessage = {
      role: 'user',
      content: 'Keep the prompt bubble.',
    };

    const { container } = render(<ChatMessage message={message} />);
    const bubble = container.querySelector('.rounded-2xl.bg-brand');
    expect(bubble).not.toBeNull();
    expect(bubble).toHaveTextContent('Keep the prompt bubble.');
  });

  it('renders the selected agent avatar for assistant replies', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'I am your design assistant.',
    };

    render(<ChatMessage message={message} assistantAvatarSrc="/assets/agent-avatars/creator.webp" />);

    const avatar = screen.getByTestId('assistant-agent-avatar');
    expect(avatar).toHaveAttribute('src', '/assets/agent-avatars/creator.webp');
  });

  it('does not render an assistant avatar image for user messages', () => {
    const message: RawMessage = {
      role: 'user',
      content: 'Hello.',
    };

    render(<ChatMessage message={message} assistantAvatarSrc="/assets/agent-avatars/creator.webp" />);

    expect(screen.queryByTestId('assistant-agent-avatar')).not.toBeInTheDocument();
  });
});

describe('ChatMessage image copy', () => {
  beforeEach(() => {
    class MockClipboardItem {
      constructor(public items: Record<string, Blob>) {}
    }
    Object.assign(globalThis, { ClipboardItem: MockClipboardItem });
    Object.assign(navigator, {
      clipboard: {
        write: vi.fn(async () => undefined),
        writeText: vi.fn(async () => undefined),
      },
    });
  });

  it('copies image bytes instead of the media URL text when an image attachment is present', async () => {
    const { readBinaryFile } = await import('@/lib/api-client');
    vi.mocked(readBinaryFile).mockResolvedValueOnce({
      ok: true,
      data: Uint8Array.from([137, 80, 78, 71]),
      mimeType: 'image/png',
    });

    const message: RawMessage = {
      role: 'assistant',
      content: 'http://127.0.0.1:18789/api/chat/media/outgoing/agent/main/full',
      _attachedFiles: [
        {
          fileName: 'cat.png',
          mimeType: 'image/png',
          fileSize: 1234,
          preview: null,
          filePath: '/tmp/cat.png',
          source: 'tool-result',
        },
      ],
    };

    render(<ChatMessage message={message} />);

    fireEvent.click(screen.getByRole('button'));
    await vi.waitFor(() => {
      expect(navigator.clipboard.write).toHaveBeenCalledTimes(1);
    });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});
