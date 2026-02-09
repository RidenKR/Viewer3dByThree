/**
 * CameraManager - 카메라 뷰, 프로젝션, 커스텀 Orbit/Pan/Zoom 관리
 *
 * xeokit viewer3d의 카메라 동작을 재현:
 * - 커스텀 Orbit: 트랙볼 자유 회전 (gimbalLock=false, 화면 기준 회전)
 * - Pan: 우클릭/중클릭/Shift+좌클릭 드래그 → 모델 크기 기반 커스텀 Pan
 * - Zoom: 휠 → 비율 기반 커스텀 줌 (모든 크기의 모델에서 일관된 동작)
 */
import * as THREE from 'three';

export class CameraManager {
  constructor(camera, renderer) {
    this.camera = camera;
    this.renderer = renderer;
    this.projection = 'perspective'; // 'perspective' | 'orthographic'
    this.initialState = null;
    this.modelBounds = null;
    this.modelSize = 1; // 모델의 maxDim (Pan/Zoom 속도 계산용)

    // Orthographic camera (projection 전환용)
    this.orthoCamera = null;

    // 회전 중심 (OrbitControls.target 대체)
    this.target = new THREE.Vector3();

    // 커스텀 인터랙션 상태
    this._isRotating = false;
    this._isPanning = false;
    this._lastX = 0;
    this._lastY = 0;
    this._rotateSpeed = 0.005;

    // FastNav 콜백
    this.onNavigationStart = null;
    this.onNavigationEnd = null;
    this._navEndTimer = null;

    this._setupInteraction();
  }

  // ───── 통합 인터랙션 Setup ─────

  _setupInteraction() {
    const canvas = this.renderer.domElement;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 && !e.shiftKey) {
        // 좌클릭: 회전
        this._isRotating = true;
      } else if (e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey)) {
        // 우클릭/중클릭/Shift+좌클릭: Pan
        this._isPanning = true;
      }
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      this._notifyNavStart();
      e.preventDefault();
    });

    canvas.addEventListener('mousemove', (e) => {
      const dx = e.clientX - this._lastX;
      const dy = e.clientY - this._lastY;
      this._lastX = e.clientX;
      this._lastY = e.clientY;

      if (this._isRotating) {
        this._rotateCamera(dx, dy);
      } else if (this._isPanning) {
        const activeCamera = this.getActiveCamera();
        this._panCamera(activeCamera, dx, dy);
      }
    });

    const onMouseUp = (e) => {
      if (e.button === 0) {
        this._isRotating = false;
      }
      if (e.button === 2 || e.button === 1 || e.button === 0) {
        this._isPanning = false;
      }
      if (!this._isRotating && !this._isPanning) {
        this._notifyNavEnd();
      }
    };

    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', () => {
      this._isRotating = false;
      this._isPanning = false;
      this._notifyNavEnd();
    });

    // 우클릭 컨텍스트 메뉴 방지
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Zoom
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._zoomCamera(e.deltaY);
      this._notifyNavStart();
      this._notifyNavEnd();
    }, { passive: false });
  }

  // ───── Custom Orbit (트랙볼 자유 회전) ─────

  /**
   * 화면 기준 자유 회전 (gimbalLock=false 방식)
   * 화면 X축 드래그 → 카메라의 up 벡터 기준 회전
   * 화면 Y축 드래그 → 카메라의 right 벡터 기준 회전
   * 극점(pole) 잠금 없이 자유롭게 회전
   */
  _rotateCamera(dx, dy) {
    const activeCamera = this.getActiveCamera();

    const angleX = -dx * this._rotateSpeed;
    const angleY = -dy * this._rotateSpeed;

    // eye → target 벡터
    const offset = new THREE.Vector3().subVectors(activeCamera.position, this.target);

    // 카메라 로컬 right 축 (화면 가로 방향)
    const right = new THREE.Vector3()
      .crossVectors(activeCamera.up, offset)
      .normalize();

    // 수직 회전: right 축 기준
    const quatY = new THREE.Quaternion().setFromAxisAngle(right, angleY);
    offset.applyQuaternion(quatY);
    activeCamera.up.applyQuaternion(quatY);

    // 수평 회전: 카메라 up 축 기준
    const quatX = new THREE.Quaternion().setFromAxisAngle(activeCamera.up, angleX);
    offset.applyQuaternion(quatX);

    // 카메라 위치 업데이트
    activeCamera.position.copy(this.target).add(offset);
    activeCamera.lookAt(this.target);
  }

  // ───── Custom Pan (모델 크기 기반) ─────

  /**
   * 카메라의 로컬 축 기반 Pan
   * xeokit 커스텀 Pan과 동일한 로직: viewDir × up → right, right × viewDir → camUp
   */
  _panCamera(camera, dx, dy) {
    const panSpeed = this.modelSize * 0.002;

    // 시선 방향
    const viewDir = new THREE.Vector3().subVectors(this.target, camera.position);

    // 오른쪽 방향 (viewDir × up)
    const right = new THREE.Vector3().crossVectors(viewDir, camera.up).normalize();

    // 카메라 실제 up (right × viewDir)
    const camUp = new THREE.Vector3().crossVectors(right, viewDir).normalize();

    // 이동량
    const moveX = -dx * panSpeed;
    const moveY = dy * panSpeed;

    const offset = new THREE.Vector3()
      .addScaledVector(right, moveX)
      .addScaledVector(camUp, moveY);

    // eye와 target 모두 이동
    camera.position.add(offset);
    this.target.add(offset);

    // Ortho 카메라 동기화
    if (this.projection === 'orthographic' && this.orthoCamera && camera !== this.orthoCamera) {
      this.orthoCamera.position.add(offset);
    } else if (this.projection === 'perspective' && camera !== this.camera) {
      this.camera.position.add(offset);
    }
  }

  // ───── Custom Zoom (비율 기반) ─────

  _zoomCamera(deltaY) {
    const activeCamera = this.getActiveCamera();

    // eye에서 target까지의 거리
    const eyeToTarget = new THREE.Vector3().subVectors(this.target, activeCamera.position);
    const currentDist = eyeToTarget.length();

    // 비율 기반 줌: deltaY > 0 (아래로) = 축소, deltaY < 0 (위로) = 확대
    const zoomSensitivity = 0.001;
    const zoomFactor = 1 + deltaY * zoomSensitivity;

    // 새 거리 (최소 거리 제한: 현재 거리의 0.1%)
    let newDist = currentDist * zoomFactor;
    const minDist = currentDist * 0.001;
    if (newDist < minDist) newDist = minDist;

    // 방향 벡터 정규화
    const dir = eyeToTarget.normalize();

    // 새 eye 위치 (target 기준으로 거리 조정)
    activeCamera.position.copy(this.target).addScaledVector(dir, -newDist);

    // Ortho 모드에서는 scale도 조정
    if (this.projection === 'orthographic' && this.orthoCamera) {
      this.orthoCamera.zoom *= (1 / zoomFactor);
      this.orthoCamera.updateProjectionMatrix();
    }
  }

  // ───── Camera State ─────

  /** 활성 카메라 반환 (perspective 또는 orthographic) */
  getActiveCamera() {
    return this.projection === 'orthographic' && this.orthoCamera
      ? this.orthoCamera
      : this.camera;
  }

  /** 모델 바운딩 박스 설정 (카메라 뷰 계산용) */
  setModelBounds(bounds) {
    this.modelBounds = bounds;
    const size = bounds.getSize(new THREE.Vector3());
    this.modelSize = Math.max(size.x, size.y, size.z);
    this._adjustClipping(bounds);
  }

  /** 카메라 클리핑 플레인 자동 조정 (xeokit과 동일) */
  _adjustClipping(bounds) {
    const maxDim = this.modelSize;

    // xeokit과 동일: near = maxSize * 0.00001, far = maxSize * 100
    const nearClip = Math.max(0.0001, maxDim * 0.00001);
    const farClip = Math.max(nearClip * 10, maxDim * 100);

    this.camera.near = nearClip;
    this.camera.far = farClip;
    this.camera.updateProjectionMatrix();

    if (this.orthoCamera) {
      this.orthoCamera.near = nearClip;
      this.orthoCamera.far = farClip;
      this.orthoCamera.updateProjectionMatrix();
    }
  }

  /** 초기 카메라 상태 저장 (Home 버튼용) */
  saveInitialState() {
    const activeCamera = this.getActiveCamera();
    this.initialState = {
      position: activeCamera.position.clone(),
      target: this.target.clone(),
      up: activeCamera.up.clone(),
      zoom: activeCamera.zoom,
    };
  }

  /** 초기 카메라 상태 복원 (Home 버튼) */
  restoreInitialState() {
    if (!this.initialState) {
      this.fitAll();
      return;
    }

    const activeCamera = this.getActiveCamera();
    activeCamera.position.copy(this.initialState.position);
    activeCamera.up.copy(this.initialState.up);
    this.target.copy(this.initialState.target);
    activeCamera.zoom = this.initialState.zoom;
    activeCamera.updateProjectionMatrix();
    activeCamera.lookAt(this.target);
  }

  // ───── Camera Views ─────

  /** 모델 전체 보기 (Fit) - 현재 뷰 방향을 유지하면서 모델을 화면에 맞춤 */
  fitAll(model) {
    if (!this.modelBounds && !model) return;

    const bounds = model
      ? new THREE.Box3().setFromObject(model)
      : this.modelBounds;

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    const activeCamera = this.getActiveCamera();

    // 현재 카메라 → target 방향 유지
    const viewDir = new THREE.Vector3()
      .subVectors(this.target, activeCamera.position)
      .normalize();

    // FOV 기반으로 모델이 화면에 들어오는 거리 계산
    let distance;
    if (this.projection === 'orthographic' && this.orthoCamera) {
      distance = maxDim * 2;
      const aspect = this.renderer.domElement.clientWidth / this.renderer.domElement.clientHeight;
      const halfHeight = maxDim * 1.2;
      this.orthoCamera.left = -halfHeight * aspect;
      this.orthoCamera.right = halfHeight * aspect;
      this.orthoCamera.top = halfHeight;
      this.orthoCamera.bottom = -halfHeight;
      this.orthoCamera.zoom = 1;
      this.orthoCamera.updateProjectionMatrix();
    } else {
      const fov = this.camera.fov * (Math.PI / 180);
      const aspect = this.renderer.domElement.clientWidth / this.renderer.domElement.clientHeight;
      const hFov = 2 * Math.atan(Math.tan(fov / 2) * aspect);
      const effectiveFov = Math.min(fov, hFov);
      distance = (maxDim / 2) / Math.tan(effectiveFov / 2) * 1.2;
    }

    // 현재 뷰 방향을 유지하면서 모델 중심에 맞춰 재배치
    activeCamera.position.copy(center).addScaledVector(viewDir, -distance);
    activeCamera.up.set(0, 1, 0);
    this.target.copy(center);
    activeCamera.updateProjectionMatrix();
    activeCamera.lookAt(this.target);
  }

  /** 카메라 뷰 프리셋 (Front/Back/Left/Right/Top/Bottom/Iso) */
  setCameraView(direction) {
    if (!this.modelBounds) return;

    const center = this.modelBounds.getCenter(new THREE.Vector3());
    const maxDim = this.modelSize;
    const distance = maxDim * 2;

    const positions = {
      front:  new THREE.Vector3(center.x, center.y, center.z + distance),
      back:   new THREE.Vector3(center.x, center.y, center.z - distance),
      left:   new THREE.Vector3(center.x - distance, center.y, center.z),
      right:  new THREE.Vector3(center.x + distance, center.y, center.z),
      top:    new THREE.Vector3(center.x, center.y + distance, center.z),
      bottom: new THREE.Vector3(center.x, center.y - distance, center.z),
      iso:    new THREE.Vector3(
        center.x + distance * 0.577,
        center.y + distance * 0.577,
        center.z + distance * 0.577
      ),
    };

    const ups = {
      front:  new THREE.Vector3(0, 1, 0),
      back:   new THREE.Vector3(0, 1, 0),
      left:   new THREE.Vector3(0, 1, 0),
      right:  new THREE.Vector3(0, 1, 0),
      top:    new THREE.Vector3(0, 0, -1),
      bottom: new THREE.Vector3(0, 0, 1),
      iso:    new THREE.Vector3(0, 1, 0),
    };

    const pos = positions[direction];
    const up = ups[direction];
    if (!pos) return;

    const activeCamera = this.getActiveCamera();
    activeCamera.position.copy(pos);
    activeCamera.up.copy(up);
    this.target.copy(center);
    activeCamera.updateProjectionMatrix();
    activeCamera.lookAt(this.target);
  }

  // ───── Projection Toggle ─────

  toggleProjection() {
    if (this.projection === 'perspective') {
      this._switchToOrthographic();
      this.projection = 'orthographic';
    } else {
      this._switchToPerspective();
      this.projection = 'perspective';
    }
    return this.projection;
  }

  _switchToOrthographic() {
    const aspect = this.renderer.domElement.clientWidth / this.renderer.domElement.clientHeight;
    const distance = this.camera.position.distanceTo(this.target);
    const halfHeight = distance * Math.tan((this.camera.fov * Math.PI) / 360);

    if (!this.orthoCamera) {
      this.orthoCamera = new THREE.OrthographicCamera(
        -halfHeight * aspect, halfHeight * aspect,
        halfHeight, -halfHeight,
        this.camera.near, this.camera.far
      );
    } else {
      this.orthoCamera.left = -halfHeight * aspect;
      this.orthoCamera.right = halfHeight * aspect;
      this.orthoCamera.top = halfHeight;
      this.orthoCamera.bottom = -halfHeight;
      this.orthoCamera.near = this.camera.near;
      this.orthoCamera.far = this.camera.far;
    }

    this.orthoCamera.position.copy(this.camera.position);
    this.orthoCamera.quaternion.copy(this.camera.quaternion);
    this.orthoCamera.up.copy(this.camera.up);
    this.orthoCamera.zoom = 1;
    this.orthoCamera.updateProjectionMatrix();
  }

  _switchToPerspective() {
    if (this.orthoCamera) {
      this.camera.position.copy(this.orthoCamera.position);
      this.camera.quaternion.copy(this.orthoCamera.quaternion);
      this.camera.up.copy(this.orthoCamera.up);
    }
    this.camera.updateProjectionMatrix();
  }

  // ───── Navigation Callbacks (FastNav) ─────

  _notifyNavStart() {
    if (this._navEndTimer) {
      clearTimeout(this._navEndTimer);
      this._navEndTimer = null;
    }
    this.onNavigationStart?.();
  }

  _notifyNavEnd() {
    if (this._navEndTimer) clearTimeout(this._navEndTimer);
    this._navEndTimer = setTimeout(() => {
      this.onNavigationEnd?.();
      this._navEndTimer = null;
    }, 150);
  }

  // ───── Update & Resize ─────

  update() {
    // 커스텀 인터랙션 - OrbitControls 없이 동작
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    if (this.orthoCamera) {
      const aspect = width / height;
      const halfHeight = (this.orthoCamera.top - this.orthoCamera.bottom) / 2;
      this.orthoCamera.left = -halfHeight * aspect;
      this.orthoCamera.right = halfHeight * aspect;
      this.orthoCamera.updateProjectionMatrix();
    }
  }

  dispose() {
    // 이벤트 리스너 정리는 canvas가 제거될 때 자동으로 처리됨
  }
}
