/**
 * Viewer - Three.js 3D 뷰어 메인 클래스
 * Scene, Renderer, 애니메이션 루프 관리
 */
import * as THREE from 'three';
import { CameraManager } from './CameraManager.js';
import { LightManager } from './LightManager.js';
import { ModelLoader } from './ModelLoader.js';

export class Viewer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) {
      throw new Error(`Container element not found: ${containerId}`);
    }

    // Core
    this.scene = null;
    this.renderer = null;
    this.camera = null;

    // Managers
    this.cameraManager = null;
    this.lightManager = null;
    this.modelLoader = null;

    // State
    this.clock = new THREE.Clock();
    this.frameCount = 0;
    this.lastFPSTime = 0;
    this.currentFPS = 0;
    this.animationId = null;
    this.isNavigating = false;
    this.isMerging = false; // 백그라운드 병합 진행 중

    // FastNav
    this.basePixelRatio = window.devicePixelRatio;

    // View mode
    this.viewMode = 'shaded-wireframe'; // 'shaded' | 'wireframe' | 'shaded-wireframe'
    this.edgeThreshold = 80;

    // Stats
    this._statsEnabled = false;
    this._statsDiv = null;
    this._lastRenderInfo = { calls: 0, triangles: 0, geometries: 0 };

    // Callbacks
    this._onUpdate = [];
    this._onModelLoaded = [];
    this._onFPSUpdate = [];

    this._init();
  }

  _init() {
    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x252525);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      45,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      10000
    );
    this.camera.position.set(5, 5, 5);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      logarithmicDepthBuffer: true,
    });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.container.appendChild(this.renderer.domElement);

    // Managers
    this.cameraManager = new CameraManager(this.camera, this.renderer);
    this.lightManager = new LightManager(this.scene);
    this.modelLoader = new ModelLoader(this.scene);

    // FastNav: 네비게이션 중 픽셀 비율 감소로 성능 향상
    this.cameraManager.onNavigationStart = () => {
      this.isNavigating = true;
      this.renderer.setPixelRatio(Math.min(this.basePixelRatio, 1));
    };
    this.cameraManager.onNavigationEnd = () => {
      this.isNavigating = false;
      this.renderer.setPixelRatio(this.basePixelRatio);
    };

    // Resize
    window.addEventListener('resize', () => this._onResize());

    // Start animation
    this._animate();
  }

  // ───── Model Loading ─────

  /**
   * URL에서 모델 로드
   * @param {string} url - 모델 파일 URL
   * @param {Function} onProgress - 진행 콜백
   */
  async loadModelFromURL(url, onProgress) {
    const result = await this.modelLoader.loadFromURL(url, onProgress);
    await this._onModelLoadComplete(result);
    return result;
  }

  /**
   * File 객체에서 모델 로드
   * @param {File} file - GLTF/GLB 파일
   * @param {Function} onProgress - 진행 콜백
   */
  async loadModelFromFile(file, onProgress) {
    const result = await this.modelLoader.loadFromFile(file, onProgress);
    await this._onModelLoadComplete(result);
    return result;
  }

  async _onModelLoadComplete(result) {
    const { bounds } = result;

    // 카메라 설정
    this.cameraManager.setModelBounds(bounds);
    this.cameraManager.setModelGroup(result.model);
    this.cameraManager.fitAll(result.model);
    this.cameraManager.saveInitialState();

    // 조명 조정
    const size = bounds.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    this.lightManager.adjustForModel(maxDim);

    // 콜백 호출 → 모델을 먼저 화면에 보여줌 (원본 메시, draw call 높지만 즉시 표시)
    this._onModelLoaded.forEach(cb => cb(result));

    // 백그라운드 병합: 모델 표시 후 비동기로 기하 병합 + 엣지 생성
    this._mergeInBackground();
  }

  /**
   * 백그라운드 기하 병합 + 엣지 생성
   * 모델은 이미 화면에 표시된 상태에서 비동기로 최적화 수행
   */
  async _mergeInBackground() {
    this.isMerging = true;
    this._onMergeProgress?.('Optimizing...');

    try {
      // 1단계: 기하 병합
      const mergeStart = performance.now();
      await this.modelLoader.mergeForRendering((progress) => {
        const pct = (progress * 100).toFixed(0);
        this._onMergeProgress?.(`Merging geometry... ${pct}%`);
      });
      const mergeTime = ((performance.now() - mergeStart) / 1000).toFixed(1);
      console.log(`[Viewer] mergeForRendering: ${mergeTime}s`);

      // 2단계: Edge 생성 (shaded-wireframe 모드일 때)
      if (this.viewMode === 'shaded-wireframe') {
        this._onMergeProgress?.('Creating edges...');
        const edgeStart = performance.now();
        await this.modelLoader.createEdges(this.edgeThreshold);
        const edgeTime = ((performance.now() - edgeStart) / 1000).toFixed(1);
        console.log(`[Viewer] createEdges: ${edgeTime}s`);
      }

      this._onMergeProgress?.(null); // 완료
      console.log(`[Viewer] Background optimization complete`);
    } catch (err) {
      console.error('[Viewer] Background merge error:', err);
      this._onMergeProgress?.(null);
    } finally {
      this.isMerging = false;
    }
  }

  /** 백그라운드 병합 진행 콜백 등록 */
  onMergeProgress(callback) {
    this._onMergeProgress = callback;
  }

  // ───── View Modes ─────

  /**
   * View mode 설정
   * @param {'shaded'|'wireframe'|'shaded-wireframe'} mode
   */
  async setViewMode(mode) {
    this.viewMode = mode;
    const model = this.modelLoader.model;
    if (!model) return;

    const isMerged = this.modelLoader.geometryMerger.isMerged;

    switch (mode) {
      case 'shaded':
        if (isMerged) {
          this.modelLoader.setMergedMeshesVisible(true, false);
        } else {
          this._setMeshVisibility(true, false);
        }
        this.modelLoader.setEdgesVisible(false);
        break;

      case 'wireframe':
        if (isMerged) {
          this.modelLoader.setMergedMeshesVisible(true, true);
        } else {
          this._setMeshVisibility(true, true);
        }
        this.modelLoader.setEdgesVisible(false);
        break;

      case 'shaded-wireframe':
        if (isMerged) {
          this.modelLoader.setMergedMeshesVisible(true, false);
        } else {
          this._setMeshVisibility(true, false);
        }
        if (this.modelLoader.edgeLines.length === 0) {
          await this.modelLoader.createEdges(this.edgeThreshold);
        }
        this.modelLoader.setEdgesVisible(true);
        break;
    }
  }

  _setMeshVisibility(visible, wireframe) {
    const model = this.modelLoader.model;
    if (!model) return;

    model.traverse((child) => {
      if (child.isMesh && child.material) {
        child.visible = visible;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(mat => {
          mat.wireframe = wireframe;
          if (wireframe) {
            mat.transparent = true;
            mat.opacity = 0.3;
          } else {
            mat.transparent = false;
            mat.opacity = 1.0;
          }
          mat.needsUpdate = true;
        });
      }
    });
  }

  // ───── Material Settings ─────

  /**
   * 모델 재질 색상 변경
   * @param {string|null} hexColor - Hex 색상 (#rrggbb) 또는 null (원본 복원)
   */
  setMaterialColor(hexColor) {
    const model = this.modelLoader.model;
    if (!model) return;

    // 원본 메시 (측정 도구용 — visible=false라도 색상 동기화)
    model.traverse((child) => {
      if (child.isMesh && child.material) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(mat => {
          if (hexColor) {
            mat.color.set(hexColor);
          }
          mat.needsUpdate = true;
        });
      }
    });

    // 병합 메시
    this.modelLoader.setMergedColor(hexColor);
  }

  /**
   * 톤 매핑 노출도 조정 (감마 대체)
   * @param {number} exposure - 노출도 (0.0~3.0)
   */
  setExposure(exposure) {
    this.renderer.toneMappingExposure = exposure;
  }

  /** 배경색 변경 */
  setBackgroundColor(hexColor) {
    this.scene.background = new THREE.Color(hexColor);
  }

  // ───── Stats Display ─────

  /**
   * 렌더 통계 오버레이 토글
   * @param {boolean} enabled
   */
  enableStats(enabled) {
    this._statsEnabled = enabled;

    if (enabled && !this._statsDiv) {
      this._statsDiv = document.createElement('div');
      this._statsDiv.style.cssText =
        'position:absolute;top:8px;left:8px;padding:6px 10px;' +
        'background:rgba(0,0,0,0.7);color:#0f0;font:11px monospace;' +
        'pointer-events:none;z-index:100;border-radius:4px;line-height:1.4;white-space:pre;';
      this.container.appendChild(this._statsDiv);
    }

    if (this._statsDiv) {
      this._statsDiv.style.display = enabled ? 'block' : 'none';
    }
  }

  /** 현재 렌더 정보 반환 */
  getRenderInfo() {
    return { ...this._lastRenderInfo };
  }

  // ───── Animation Loop ─────

  _animate() {
    this.animationId = requestAnimationFrame(() => this._animate());

    this.cameraManager.update();

    // 활성 카메라로 렌더
    const activeCamera = this.cameraManager.getActiveCamera();
    this.renderer.render(this.scene, activeCamera);

    // 렌더 정보 캡처 (render() 직후)
    const info = this.renderer.info;
    this._lastRenderInfo = {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
    };

    // Update 콜백 (측정 라벨 업데이트 등)
    this._onUpdate.forEach(cb => cb(activeCamera));

    // FPS 카운터
    this.frameCount++;
    const elapsed = this.clock.getElapsedTime();
    if (elapsed - this.lastFPSTime >= 1) {
      this.currentFPS = Math.round(this.frameCount / (elapsed - this.lastFPSTime));
      this.frameCount = 0;
      this.lastFPSTime = elapsed;
      this._onFPSUpdate.forEach(cb => cb(this.currentFPS));

      // Stats 업데이트 (1초마다)
      if (this._statsEnabled && this._statsDiv) {
        const r = this._lastRenderInfo;
        this._statsDiv.textContent =
          `FPS: ${this.currentFPS}\n` +
          `Draw Calls: ${r.calls}\n` +
          `Triangles: ${r.triangles.toLocaleString()}\n` +
          `Geometries: ${r.geometries}`;
      }
    }
  }

  _onResize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    this.renderer.setSize(width, height);
    this.cameraManager.onResize(width, height);
  }

  // ───── Event Registration ─────

  /** 매 프레임 업데이트 콜백 등록 */
  onUpdate(callback) {
    this._onUpdate.push(callback);
  }

  /** 모델 로드 완료 콜백 등록 */
  onModelLoaded(callback) {
    this._onModelLoaded.push(callback);
  }

  /** FPS 업데이트 콜백 등록 */
  onFPSUpdate(callback) {
    this._onFPSUpdate.push(callback);
  }

  // ───── Cleanup ─────

  dispose() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    this.cameraManager.dispose();
    this.lightManager.dispose();
    this.modelLoader.disposeModel();
    this.renderer.dispose();

    if (this._statsDiv && this._statsDiv.parentNode) {
      this._statsDiv.parentNode.removeChild(this._statsDiv);
    }

    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
