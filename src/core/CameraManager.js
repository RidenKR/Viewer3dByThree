/**
 * CameraManager - 카메라 뷰, 프로젝션, 커스텀 Orbit/Pan/Zoom 관리
 *
 * - Orbit: this.target 주위로 쿼터니언 자유 회전 (gimbalLock=false)
 * - Pan: camera + target 함께 이동
 * - Zoom: 로그 스케일 dolly
 * - this.target: lookAt 대상 + orbit 중심 (fitAll/setCameraView에서 모델 중심으로 설정)
 */
import * as THREE from 'three';

export class CameraManager {
  constructor(camera, renderer, scene) {
    this.camera = camera;
    this.renderer = renderer;
    this.scene = scene;
    this.projection = 'perspective'; // 'perspective' | 'orthographic'
    this.initialState = null;
    this.modelBounds = null;
    this.modelSize = 1; // 모델의 maxDim (Pan/Zoom 속도 계산용)

    // Orthographic camera (projection 전환용)
    this.orthoCamera = null;

    // orbit 중심 + lookAt 대상
    this.target = new THREE.Vector3();

    // 네비게이션 모드: 'orbit' | 'pan' | 'zoom' | 'zoomBox'
    this.navMode = 'orbit';

    // 커스텀 인터랙션 상태
    this._isRotating = false;
    this._isPanning = false;
    this._isZooming = false;
    this._isBoxSelect = false;
    this._boxStart = { x: 0, y: 0 };
    this._boxOverlay = null;
    this._lastX = 0;
    this._lastY = 0;
    this._rotateSpeed = 0.005;

    // 회전 모드: 'maya' (수평=월드Y 고정, polar 제한) | 'trackball' (완전 자유 회전)
    this.rotateMode = 'maya';

    // FastNav 콜백
    this.onNavigationStart = null;
    this.onNavigationEnd = null;
    this._navEndTimer = null;
    this._isNavigating = false;

    this._setupInteraction();
    this._setupKeyboardRotation();
  }

  // ───── 통합 인터랙션 Setup ─────

  _setupInteraction() {
    const canvas = this.renderer.domElement;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 && !e.shiftKey) {
        // 좌클릭: navMode에 따라 분기
        switch (this.navMode) {
          case 'orbit':
            this._isRotating = true;
            break;
          case 'pan':
            this._isPanning = true;
            break;
          case 'zoom':
            this._isZooming = true;
            break;
          case 'zoomBox':
            this._isBoxSelect = true;
            this._boxStart = { x: e.clientX, y: e.clientY };
            this._createBoxOverlay(e.clientX, e.clientY);
            break;
        }
      } else if (e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey)) {
        // 우클릭/중클릭/Shift+좌클릭: Pan (모든 모드에서)
        this._isPanning = true;
      }
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      if (!this._isBoxSelect) this._notifyNavStart();
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
      } else if (this._isZooming) {
        this._zoomCamera(dy * 3);
        this._notifyNavStart();
        this._notifyNavEnd();
      } else if (this._isBoxSelect) {
        this._updateBoxOverlay(e.clientX, e.clientY);
      }
    });

    const onMouseUp = (e) => {
      if (e.button === 0) {
        if (this._isBoxSelect) {
          this._finishBoxSelect(e.clientX, e.clientY);
          this._isBoxSelect = false;
        }
        this._isRotating = false;
        this._isZooming = false;
      }
      if (e.button === 2 || e.button === 1 || e.button === 0) {
        this._isPanning = false;
      }
      if (!this._isRotating && !this._isPanning && !this._isZooming && !this._isBoxSelect) {
        this._notifyNavEnd();
      }
    };

    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', () => {
      this._isRotating = false;
      this._isPanning = false;
      this._isZooming = false;
      if (this._isBoxSelect) {
        this._removeBoxOverlay();
        this._isBoxSelect = false;
      }
      this._notifyNavEnd();
    });

    // 우클릭 컨텍스트 메뉴 방지
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Zoom (휠 — 모든 모드에서 작동)
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      // deltaMode 정규화: 0=pixel, 1=line(×16), 2=page(×400)
      let deltaY = e.deltaY;
      if (e.deltaMode === 1) deltaY *= 16;
      else if (e.deltaMode === 2) deltaY *= 400;
      this._notifyNavStart();
      this._zoomCamera(deltaY);
      this._notifyNavEnd();
    }, { passive: false });
  }

  // ───── Keyboard Rotation (방향키 회전) ─────

  /**
   * 방향키로 카메라 회전 (테스트용)
   * ← → : 수평 회전 (Y축)
   * ↑ ↓ : 수직 회전 (X축)
   * Shift + 방향키: 속도 5배
   */
  _setupKeyboardRotation() {
    this._keysDown = new Set();
    this._keyRotateStep = 8; // 픽셀 단위 (마우스 드래그와 동일한 스케일)
    this._keyRotateRAF = null;

    const onKeyDown = (e) => {
      const arrows = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
      if (!arrows.includes(e.key)) return;

      // 입력창(input/textarea)에 포커스가 있으면 무시
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      e.preventDefault();
      this._keysDown.add(e.key);
      if (!this._keyRotateRAF) this._startKeyRotateLoop();
    };

    const onKeyUp = (e) => {
      this._keysDown.delete(e.key);
      if (this._keysDown.size === 0) {
        this._stopKeyRotateLoop();
        this._notifyNavEnd();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // dispose 시 정리용 참조 보관
    this._keyListeners = { onKeyDown, onKeyUp };
  }

  _startKeyRotateLoop() {
    this._notifyNavStart();
    const loop = () => {
      if (this._keysDown.size === 0) { this._keyRotateRAF = null; return; }

      const step = this._keysDown.has('Shift')
        ? this._keyRotateStep * 5
        : this._keyRotateStep;

      let dx = 0, dy = 0;
      if (this._keysDown.has('ArrowLeft'))  dx = -step;
      if (this._keysDown.has('ArrowRight')) dx =  step;
      if (this._keysDown.has('ArrowUp'))    dy = -step;
      if (this._keysDown.has('ArrowDown'))  dy =  step;

      if (dx !== 0 || dy !== 0) this._rotateCamera(dx, dy);

      this._keyRotateRAF = requestAnimationFrame(loop);
    };
    this._keyRotateRAF = requestAnimationFrame(loop);
  }

  _stopKeyRotateLoop() {
    if (this._keyRotateRAF) {
      cancelAnimationFrame(this._keyRotateRAF);
      this._keyRotateRAF = null;
    }
  }

  // ───── Custom Orbit (트랙볼 자유 회전) ─────

  /**
   * this.target 주위로 자유 회전 (gimbalLock=false)
   * - 화면 X축 드래그 → 카메라 up 기준 수평 회전
   * - 화면 Y축 드래그 → 카메라 right 기준 수직 회전
   */
  _rotateCamera(dx, dy) {
    if (this.rotateMode === 'trackball') {
      this._rotateCameraTrackball(dx, dy);
    } else {
      this._rotateCameraMaya(dx, dy);
    }
  }

  /** Maya 스타일: 수평=월드Y 고정, 수직=로컬Right, polar 제한(5°~175°) */
  _rotateCameraMaya(dx, dy) {
    const activeCamera = this.getActiveCamera();

    const angleX = -dx * this._rotateSpeed;
    const angleY = -dy * this._rotateSpeed;

    const offset = new THREE.Vector3().subVectors(activeCamera.position, this.target);
    const worldUp = new THREE.Vector3(0, 1, 0);

    // 수평 회전: 월드 Y축 기준
    const quatX = new THREE.Quaternion().setFromAxisAngle(worldUp, angleX);
    offset.applyQuaternion(quatX);

    // 수직 회전: 로컬 right 축 + polar 제한
    const right = new THREE.Vector3().crossVectors(worldUp, offset).normalize();
    const polarMin = 5   * (Math.PI / 180);
    const polarMax = 175 * (Math.PI / 180);
    const currentPolar = offset.angleTo(worldUp);
    const newPolar = currentPolar + angleY;

    if (newPolar >= polarMin && newPolar <= polarMax) {
      const quatY = new THREE.Quaternion().setFromAxisAngle(right, angleY);
      offset.applyQuaternion(quatY);
    } else {
      const clampAngle = Math.max(polarMin, Math.min(polarMax, newPolar)) - currentPolar;
      if (Math.abs(clampAngle) > 1e-6) {
        const quatY = new THREE.Quaternion().setFromAxisAngle(right, clampAngle);
        offset.applyQuaternion(quatY);
      }
    }

    activeCamera.up.copy(worldUp);
    activeCamera.position.copy(this.target).add(offset);
    activeCamera.lookAt(this.target);
  }

  /** 트랙볼 스타일: 완전 자유 회전, gimbal lock 없음 (up 누적 오류 주의) */
  _rotateCameraTrackball(dx, dy) {
    const activeCamera = this.getActiveCamera();

    const angleX = -dx * this._rotateSpeed;
    const angleY = -dy * this._rotateSpeed;

    const offset = new THREE.Vector3().subVectors(activeCamera.position, this.target);

    // 수직 회전: 로컬 right 축 기준
    const right = new THREE.Vector3()
      .crossVectors(activeCamera.up, offset)
      .normalize();
    const quatY = new THREE.Quaternion().setFromAxisAngle(right, angleY);
    offset.applyQuaternion(quatY);
    activeCamera.up.applyQuaternion(quatY);

    // 수평 회전: 현재 camera.up 기준
    const quatX = new THREE.Quaternion().setFromAxisAngle(activeCamera.up, angleX);
    offset.applyQuaternion(quatX);

    activeCamera.position.copy(this.target).add(offset);
    activeCamera.lookAt(this.target);
  }

  /** 회전 모드 전환 ('maya' ↔ 'trackball') */
  toggleRotateMode() {
    this.rotateMode = this.rotateMode === 'maya' ? 'trackball' : 'maya';
    // 트랙볼→Maya 전환 시 up 벡터 정규화
    if (this.rotateMode === 'maya') {
      this.getActiveCamera().up.set(0, 1, 0);
    }
    return this.rotateMode;
  }

  // ───── Custom Pan (모델 크기 기반) ─────

  /**
   * 카메라의 로컬 축 기반 Pan
   * xeokit 커스텀 Pan과 동일한 로직: viewDir × up → right, right × viewDir → camUp
   */
  _panCamera(camera, dx, dy) {
    // 카메라-타겟 거리에 비례: 확대 시 느리게, 축소 시 빠르게
    const dist = camera.position.distanceTo(this.target);
    const panSpeed = dist * 0.002;

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

  // ───── Custom Zoom (로그 스케일) ─────

  _zoomCamera(deltaY) {
    const activeCamera = this.getActiveCamera();

    const eyeToTarget = new THREE.Vector3().subVectors(this.target, activeCamera.position);
    const currentDist = eyeToTarget.length();
    const dir = eyeToTarget.normalize();

    // 로그 스케일 줌
    const logDist = Math.log(currentDist);
    let step = deltaY * 0.001; // 양수 = 축소, 음수 = 확대

    // 최소/최대 거리 제한: 한 스텝 후 한계 도달 시 줌 차단 (비율 왜곡 방지)
    const minDist = this.modelSize * 0.001;
    const maxDist = this.modelSize * 100;
    const newLogDist = logDist + step;
    const newDist = Math.exp(newLogDist);

    if (newDist < minDist || newDist > maxDist) return;

    activeCamera.position.copy(this.target).addScaledVector(dir, -newDist);

    // near plane 동적 조정
    activeCamera.near = newDist * 0.001;
    activeCamera.updateProjectionMatrix();

    // Ortho 모드
    if (this.projection === 'orthographic' && this.orthoCamera) {
      const zoomFactor = currentDist / newDist;
      this.orthoCamera.zoom *= zoomFactor;
      this.orthoCamera.updateProjectionMatrix();
    }
  }

  // ───── Zoom Box ─────

  _createBoxOverlay(x, y) {
    this._removeBoxOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'zoom-box-overlay';
    overlay.style.left = x + 'px';
    overlay.style.top = y + 'px';
    overlay.style.width = '0px';
    overlay.style.height = '0px';
    document.body.appendChild(overlay);
    this._boxOverlay = overlay;
  }

  _updateBoxOverlay(x, y) {
    if (!this._boxOverlay) return;
    const sx = this._boxStart.x;
    const sy = this._boxStart.y;
    const left = Math.min(sx, x);
    const top = Math.min(sy, y);
    const width = Math.abs(x - sx);
    const height = Math.abs(y - sy);
    this._boxOverlay.style.left = left + 'px';
    this._boxOverlay.style.top = top + 'px';
    this._boxOverlay.style.width = width + 'px';
    this._boxOverlay.style.height = height + 'px';
  }

  _removeBoxOverlay() {
    if (this._boxOverlay) {
      this._boxOverlay.remove();
      this._boxOverlay = null;
    }
  }

  _finishBoxSelect(ex, ey) {
    this._removeBoxOverlay();
    const sx = this._boxStart.x;
    const sy = this._boxStart.y;

    // 최소 크기 체크 (너무 작은 드래그 무시)
    if (Math.abs(ex - sx) < 10 || Math.abs(ey - sy) < 10) return;

    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();

    // 화면 좌표 → NDC (-1 ~ +1)
    const toNDC = (px, py) => ({
      x: ((px - rect.left) / rect.width) * 2 - 1,
      y: -((py - rect.top) / rect.height) * 2 + 1,
    });

    const ndc1 = toNDC(sx, sy);
    const ndc2 = toNDC(ex, ey);
    const ndcCenter = {
      x: (ndc1.x + ndc2.x) / 2,
      y: (ndc1.y + ndc2.y) / 2,
    };
    const ndcWidth = Math.abs(ndc2.x - ndc1.x);
    const ndcHeight = Math.abs(ndc2.y - ndc1.y);

    const activeCamera = this.getActiveCamera();

    const dist = activeCamera.position.distanceTo(this.target);

    // 영역 중심 방향
    const centerVec = new THREE.Vector3(ndcCenter.x, ndcCenter.y, 0.5);
    centerVec.unproject(activeCamera);
    const dir = centerVec.sub(activeCamera.position).normalize();

    // 선택 영역 내 여러 지점에서 raycast (중심 + 4모서리 + 4변 중점 = 9발)
    let closestDist = Infinity;
    if (this.scene) {
      const raycaster = new THREE.Raycaster();
      const samplePoints = [
        { x: ndcCenter.x, y: ndcCenter.y }, // 중심
        { x: ndc1.x, y: ndc1.y },           // 모서리 4개
        { x: ndc2.x, y: ndc1.y },
        { x: ndc1.x, y: ndc2.y },
        { x: ndc2.x, y: ndc2.y },
        { x: ndcCenter.x, y: ndc1.y },      // 변 중점 4개
        { x: ndcCenter.x, y: ndc2.y },
        { x: ndc1.x, y: ndcCenter.y },
        { x: ndc2.x, y: ndcCenter.y },
      ];

      for (const pt of samplePoints) {
        const ptVec = new THREE.Vector3(pt.x, pt.y, 0.5);
        ptVec.unproject(activeCamera);
        const ptDir = ptVec.sub(activeCamera.position).normalize();
        raycaster.set(activeCamera.position, ptDir);
        const hits = raycaster.intersectObjects(this.scene.children, true)
          .filter(h => h.object.isMesh);
        if (hits.length > 0 && hits[0].distance < closestDist) {
          closestDist = hits[0].distance;
        }
      }
    }

    // 표면 히트가 있으면 해당 깊이 사용, 없으면 기존 target 거리
    const surfaceDist = closestDist < Infinity ? closestDist : dist;
    const newTarget = new THREE.Vector3().copy(activeCamera.position).addScaledVector(dir, surfaceDist);

    // 줌 비율: 선택 영역이 화면을 채우도록
    const zoomRatio = Math.max(ndcWidth / 2, ndcHeight / 2);
    const newDist = surfaceDist * zoomRatio;

    // 표면 앞으로 뚫고 들어가지 않도록 최소 거리 제한
    const surfaceMinDist = surfaceDist * 0.1; // 표면 거리의 10%
    const absoluteMinDist = this.modelSize * 0.002;
    const finalDist = Math.max(newDist, surfaceMinDist, absoluteMinDist);

    // 카메라 재배치
    const viewDir = new THREE.Vector3().subVectors(newTarget, activeCamera.position).normalize();
    activeCamera.position.copy(newTarget).addScaledVector(viewDir, -finalDist);
    this.target.copy(newTarget);

    // Ortho 줌
    if (this.projection === 'orthographic' && this.orthoCamera) {
      this.orthoCamera.zoom *= (dist / finalDist);
      this.orthoCamera.updateProjectionMatrix();
    }

    // near plane 조정
    activeCamera.near = finalDist * 0.001;
    activeCamera.updateProjectionMatrix();

    this._notifyNavStart();
    this._notifyNavEnd();
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

  /** Raycast 대상 모델 그룹 설정 */
  setModelGroup(group) {
    this._modelGroup = group;
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
    if (!this._isNavigating) {
      this._isNavigating = true;
      this.onNavigationStart?.();
    }
  }

  _notifyNavEnd() {
    if (this._navEndTimer) clearTimeout(this._navEndTimer);
    this._navEndTimer = setTimeout(() => {
      this._isNavigating = false;
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
    this._stopKeyRotateLoop();
    if (this._keyListeners) {
      window.removeEventListener('keydown', this._keyListeners.onKeyDown);
      window.removeEventListener('keyup', this._keyListeners.onKeyUp);
    }
  }
}
