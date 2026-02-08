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

    // View mode
    this.viewMode = 'shaded-wireframe'; // 'shaded' | 'wireframe' | 'shaded-wireframe'
    this.edgeThreshold = 80;

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
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.container.appendChild(this.renderer.domElement);

    // Managers
    this.cameraManager = new CameraManager(this.camera, this.renderer);
    this.lightManager = new LightManager(this.scene);
    this.modelLoader = new ModelLoader(this.scene);

    // FastNav 최적화: 네비게이션 중 해상도 감소
    this.cameraManager.controls.addEventListener('start', () => {
      this.isNavigating = true;
    });
    this.cameraManager.controls.addEventListener('end', () => {
      this.isNavigating = false;
    });

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
    this._onModelLoadComplete(result);
    return result;
  }

  /**
   * File 객체에서 모델 로드
   * @param {File} file - GLTF/GLB 파일
   * @param {Function} onProgress - 진행 콜백
   */
  async loadModelFromFile(file, onProgress) {
    const result = await this.modelLoader.loadFromFile(file, onProgress);
    this._onModelLoadComplete(result);
    return result;
  }

  _onModelLoadComplete(result) {
    const { bounds } = result;

    // 카메라 설정
    this.cameraManager.setModelBounds(bounds);
    this.cameraManager.fitAll(result.model);
    this.cameraManager.saveInitialState();

    // 조명 조정
    const size = bounds.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    this.lightManager.adjustForModel(maxDim);

    // View mode에 따라 Edge 생성
    if (this.viewMode === 'shaded-wireframe') {
      this.modelLoader.createEdges(this.edgeThreshold);
    }

    // 콜백 호출
    this._onModelLoaded.forEach(cb => cb(result));
  }

  // ───── View Modes ─────

  /**
   * View mode 설정
   * @param {'shaded'|'wireframe'|'shaded-wireframe'} mode
   */
  setViewMode(mode) {
    this.viewMode = mode;
    const model = this.modelLoader.model;
    if (!model) return;

    switch (mode) {
      case 'shaded':
        this._setMeshVisibility(true, false);
        this.modelLoader.setEdgesVisible(false);
        break;

      case 'wireframe':
        this._setMeshVisibility(true, true);
        this.modelLoader.setEdgesVisible(false);
        break;

      case 'shaded-wireframe':
        this._setMeshVisibility(true, false);
        if (this.modelLoader.edgeLines.length === 0) {
          this.modelLoader.createEdges(this.edgeThreshold);
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

    model.traverse((child) => {
      if (child.isMesh && child.material) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(mat => {
          if (hexColor) {
            mat.color.set(hexColor);
          }
          // null이면 원본 유지 (이미 로드 시 설정된 색상)
          mat.needsUpdate = true;
        });
      }
    });
  }

  /**
   * 톤 매핑 노출도 조정 (감마 대체)
   * @param {number} exposure - 노출도 (0.0~3.0)
   */
  setExposure(exposure) {
    this.renderer.toneMappingExposure = exposure;
  }

  // ───── Animation Loop ─────

  _animate() {
    this.animationId = requestAnimationFrame(() => this._animate());

    this.cameraManager.update();

    // 활성 카메라로 렌더
    const activeCamera = this.cameraManager.getActiveCamera();
    this.renderer.render(this.scene, activeCamera);

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

    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
