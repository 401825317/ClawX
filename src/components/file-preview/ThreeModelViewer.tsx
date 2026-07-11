import { useEffect, useRef, useState } from 'react';
import { Box, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { invokeIpc } from '@/lib/api-client';
import { confirmAndOpenFile } from './open-file-utils';

const MAX_GLTF_BYTES = 50 * 1024 * 1024;

type BinaryReadResult = {
  ok: boolean;
  data?: Uint8Array;
  size?: number;
  error?: string;
};

type ViewerStatus = 'loading' | 'ready' | 'unsupported' | 'error';

function disposeObject(object: import('three').Object3D): void {
  object.traverse((child) => {
    const mesh = child as import('three').Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value && typeof value === 'object' && 'isTexture' in value) {
          (value as import('three').Texture).dispose();
        }
      }
      material.dispose();
    }
  });
}

export function ThreeModelViewer({ filePath, fileName }: { filePath: string; fileName: string }) {
  const { t } = useTranslation('chat');
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const resetRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<ViewerStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const isGlb = /\.glb$/iu.test(fileName);

  useEffect(() => {
    if (!isGlb) {
      setStatus('unsupported');
      return;
    }
    const host = canvasRef.current;
    if (!host) return;
    let disposed = false;
    let frameId = 0;
    let cleanup: (() => void) | undefined;
    setStatus('loading');
    setError(null);

    void (async () => {
      try {
        const read = await invokeIpc<BinaryReadResult>('file:readBinary', filePath, { maxBytes: MAX_GLTF_BYTES });
        if (!read.ok || !read.data) throw new Error(read.error || 'Unable to read GLB model');
        const [{
          AmbientLight,
          Box3,
          Color,
          DirectionalLight,
          Group,
          PerspectiveCamera,
          Scene,
          Vector3,
          WebGLRenderer,
        }, { GLTFLoader }, { OrbitControls }] = await Promise.all([
          import('three'),
          import('three/examples/jsm/loaders/GLTFLoader.js'),
          import('three/examples/jsm/controls/OrbitControls.js'),
        ]);
        if (disposed) return;
        const renderer = new WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.outputColorSpace = 'srgb';
        renderer.setClearColor(new Color('#10141b'));
        renderer.domElement.className = 'h-full w-full';
        host.replaceChildren(renderer.domElement);

        const scene = new Scene();
        const stage = new Group();
        scene.add(stage);
        scene.add(new AmbientLight(0xffffff, 1.8));
        const key = new DirectionalLight(0xcfe8ff, 3.2);
        key.position.set(5, 6, 7);
        scene.add(key);
        const fill = new DirectionalLight(0x7e9cff, 1.3);
        fill.position.set(-5, 2, -4);
        scene.add(fill);
        const camera = new PerspectiveCamera(42, 1, 0.01, 5_000);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = 0.05;
        const target = new Vector3();
        let model: import('three').Object3D | undefined;

        const render = (): void => {
          if (disposed) return;
          controls.update();
          renderer.render(scene, camera);
          frameId = window.requestAnimationFrame(render);
        };
        const resize = (): void => {
          const width = Math.max(1, host.clientWidth);
          const height = Math.max(1, host.clientHeight);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        };
        const frameModel = (): void => {
          if (!model) return;
          const bounds = new Box3().setFromObject(model);
          const center = bounds.getCenter(new Vector3());
          const size = bounds.getSize(new Vector3());
          const radius = Math.max(size.x, size.y, size.z, 0.15) * 0.8;
          const distance = radius / Math.tan((camera.fov * Math.PI) / 360) * 1.45;
          target.copy(center);
          controls.target.copy(center);
          camera.position.set(center.x + distance, center.y + distance * 0.62, center.z + distance);
          camera.near = Math.max(distance / 1_000, 0.01);
          camera.far = Math.max(distance * 20, 100);
          camera.updateProjectionMatrix();
          controls.update();
        };
        resetRef.current = frameModel;
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(host);
        resize();
        const data = read.data.buffer.slice(read.data.byteOffset, read.data.byteOffset + read.data.byteLength) as ArrayBuffer;
        const loader = new GLTFLoader();
        loader.parse(data, '', (gltf) => {
          if (disposed) return;
          model = gltf.scene;
          stage.add(model);
          frameModel();
          setStatus('ready');
        }, (loadError) => {
          if (disposed) return;
          setError(loadError.message || 'Invalid GLB model');
          setStatus('error');
        });
        render();
        cleanup = () => {
          resizeObserver.disconnect();
          window.cancelAnimationFrame(frameId);
          if (model) disposeObject(model);
          controls.dispose();
          renderer.dispose();
          host.replaceChildren();
        };
      } catch (loadError) {
        if (disposed) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStatus('error');
      }
    })();
    return () => {
      disposed = true;
      resetRef.current = null;
      cleanup?.();
    };
  }, [filePath, isGlb]);

  const openDirectly = async (): Promise<void> => {
    await confirmAndOpenFile({ filePath, fileName, t });
  };

  if (status === 'unsupported') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Box className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{t('filePreview.model3d.externalOnly')}</p>
        <Button size="sm" onClick={() => void openDirectly()}>{t('filePreview.actions.openDirectly')}</Button>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-[280px] overflow-hidden bg-[#10141b]">
      <div ref={canvasRef} className="h-full min-h-[280px] w-full" />
      {status === 'loading' && <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">{t('filePreview.model3d.loading')}</div>}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#10141b] p-6 text-center">
          <p className="max-w-md text-sm text-white/70">{t('filePreview.model3d.loadFailed', { error })}</p>
          <Button size="sm" variant="outline" onClick={() => void openDirectly()}>{t('filePreview.actions.openDirectly')}</Button>
        </div>
      )}
      {status === 'ready' && (
        <Button className="absolute right-3 top-3" size="icon" variant="secondary" onClick={() => resetRef.current?.()} title={t('filePreview.model3d.reset')}>
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
