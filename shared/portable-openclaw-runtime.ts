import type { LanguageCode } from './language';

/** Stages reported while the packaged portable OpenClaw runtime is made local. */
export type PortableOpenClawRuntimePreparationPhase =
  | 'validating'
  | 'cleanup'
  | 'scanning'
  | 'copying'
  | 'publishing'
  | 'done'
  | 'failed';

export type PortableOpenClawRuntimePreparationProgress = {
  phase: PortableOpenClawRuntimePreparationPhase;
  percent?: number;
  copiedBytes?: number;
  totalBytes?: number;
  copiedFiles?: number;
  totalFiles?: number;
  currentFile?: string;
};

/** Localized copy for the standalone first-launch preparation window. */
export type PortableOpenClawRuntimePreparationCopy = {
  title: string;
  defaultMessage: string;
  copyingMessage: string;
  publishingMessage: string;
  failedMessage: string;
  progressLabel: string;
  filesUnit: string;
  initialStage: string;
  stageLabels: Record<PortableOpenClawRuntimePreparationPhase, string>;
};

export const PORTABLE_OPENCLAW_RUNTIME_PREPARATION_COPY: Record<
  LanguageCode,
  PortableOpenClawRuntimePreparationCopy
> = {
  en: {
    title: 'Preparing runtime environment',
    defaultMessage: 'The first launch on this computer may take a few minutes. Keep the USB drive connected.',
    copyingMessage: 'Copying the runtime from the USB drive to the local cache. Keep the USB drive connected.',
    publishingMessage: 'Copy complete. Switching to the local runtime.',
    failedMessage: 'Keep the USB drive connected and check system disk space or security software.',
    progressLabel: 'Runtime preparation progress',
    filesUnit: 'files',
    initialStage: 'Initializing',
    stageLabels: {
      validating: 'Checking runtime files',
      cleanup: 'Cleaning up incomplete temporary files',
      scanning: 'Counting files to copy',
      copying: 'Copying runtime files',
      publishing: 'Enabling local runtime cache',
      done: 'Runtime environment ready',
      failed: 'Runtime preparation failed',
    },
  },
  zh: {
    title: '正在准备运行环境',
    defaultMessage: '首次在这台电脑启动可能需要几分钟，请保持 U 盘连接。',
    copyingMessage: '正在从 U 盘复制运行时到本机缓存，请保持 U 盘连接。',
    publishingMessage: '复制已完成，正在切换到本机运行时。',
    failedMessage: '请保持 U 盘连接，并检查系统盘空间或安全软件拦截。',
    progressLabel: '运行环境准备进度',
    filesUnit: '个文件',
    initialStage: '正在初始化',
    stageLabels: {
      validating: '正在校验运行时文件',
      cleanup: '正在清理上次未完成的临时文件',
      scanning: '正在统计需要复制的文件',
      copying: '正在复制运行时文件',
      publishing: '正在启用本机运行时缓存',
      done: '运行环境已准备完成',
      failed: '运行环境准备失败',
    },
  },
  ja: {
    title: '実行環境を準備中',
    defaultMessage: 'このコンピューターでの初回起動には数分かかる場合があります。USB ドライブを接続したままにしてください。',
    copyingMessage: 'USB ドライブからローカルキャッシュへ実行環境をコピーしています。USB ドライブを接続したままにしてください。',
    publishingMessage: 'コピーが完了しました。ローカルの実行環境へ切り替えています。',
    failedMessage: 'USB ドライブを接続したまま、システムディスクの空き容量とセキュリティソフトを確認してください。',
    progressLabel: '実行環境の準備状況',
    filesUnit: 'ファイル',
    initialStage: '初期化中',
    stageLabels: {
      validating: '実行環境のファイルを確認中',
      cleanup: '前回未完了の一時ファイルを整理中',
      scanning: 'コピーするファイルを集計中',
      copying: '実行環境のファイルをコピー中',
      publishing: 'ローカルキャッシュを有効化中',
      done: '実行環境の準備が完了しました',
      failed: '実行環境の準備に失敗しました',
    },
  },
  ru: {
    title: 'Подготовка среды выполнения',
    defaultMessage: 'Первый запуск на этом компьютере может занять несколько минут. Не отключайте USB-накопитель.',
    copyingMessage: 'Среда выполнения копируется с USB-накопителя в локальный кэш. Не отключайте USB-накопитель.',
    publishingMessage: 'Копирование завершено. Переключение на локальную среду выполнения.',
    failedMessage: 'Не отключайте USB-накопитель и проверьте свободное место на системном диске и блокировку со стороны защитного ПО.',
    progressLabel: 'Прогресс подготовки среды выполнения',
    filesUnit: 'файлов',
    initialStage: 'Инициализация',
    stageLabels: {
      validating: 'Проверка файлов среды выполнения',
      cleanup: 'Очистка незавершённых временных файлов',
      scanning: 'Подсчёт файлов для копирования',
      copying: 'Копирование файлов среды выполнения',
      publishing: 'Включение локального кэша среды выполнения',
      done: 'Среда выполнения готова',
      failed: 'Не удалось подготовить среду выполнения',
    },
  },
};
