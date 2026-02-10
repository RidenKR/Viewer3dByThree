/**
 * MeasurementManager - 측정 도구 공통 인프라
 * HTML overlay 기반 측정 라벨, 마커, 라인 관리
 *
 * 마커는 THREE.Sprite + sizeAttenuation:false → 화면상 고정 크기 (매 프레임 계산 불필요)
 */
import * as THREE from 'three';

// 원형 마커 텍스처 (Canvas 기반, 1회 생성 후 재사용)
let _circleTexture = null;
function getCircleTexture() {
  if (_circleTexture) return _circleTexture;
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  _circleTexture = new THREE.CanvasTexture(canvas);
  return _circleTexture;
}

/**
 * 화면상 고정 크기 원형 마커 생성 (Sprite)
 * @param {THREE.Vector3} position
 * @param {number} color - hex color
 * @param {number} pixelSize - 화면상 크기 (기본 6)
 * @returns {THREE.Sprite}
 */
export function createFixedMarker(position, color, pixelSize = 6) {
  const mat = new THREE.SpriteMaterial({
    map: getCircleTexture(),
    color,
    depthTest: false,
    transparent: true,
    opacity: 0.9,
    sizeAttenuation: false, // 핵심: 카메라 거리와 무관하게 고정 크기
  });
  const sprite = new THREE.Sprite(mat);
  sprite.position.copy(position);
  sprite.renderOrder = 999;
  // sizeAttenuation:false일 때 scale은 NDC 단위 (1 = 화면 전체 높이)
  // pixelSize 픽셀을 원하면: scale = pixelSize / canvasHeight
  // 이 값은 resize 시 업데이트가 필요하지만, 마커 수가 적어 무시 가능
  // 기본 캔버스 높이 800 기준 합리적인 값 사용
  const ndcScale = pixelSize / 800;
  sprite.scale.set(ndcScale, ndcScale, 1);
  return sprite;
}

export class MeasurementManager {
  constructor(viewer, labelsContainerId = 'labels-container') {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.labelsContainer = document.getElementById(labelsContainerId);
    this.measurements = [];
    this.metricsScale = 1;
    this.nextId = 1;

    // 카메라 업데이트 시 라벨 위치 동기화
    viewer.onUpdate((camera) => this.updateLabels(camera));
  }

  /** 측정 단위 스케일 설정 */
  setMetricsScale(scale) {
    this.metricsScale = scale;
  }

  /**
   * 측정값 포맷
   * @param {number} value - raw 측정값
   * @returns {string} 포맷된 문자열 (예: "1,234.56 mm")
   */
  formatValue(value) {
    const scaled = value * this.metricsScale;
    return `${scaled.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mm`;
  }

  /**
   * 거리 측정 생성 (라인 + 마커 + 라벨)
   */
  createMeasurement(start, end, type = 'distance') {
    const id = this.nextId++;
    const length = start.distanceTo(end);
    const midPoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);

    const colorMap = {
      distance: 0x00ffff,
      edge: 0x00ff88,
      diameter: 0x00e5ff,
    };
    const labelClassMap = {
      distance: 'measurement-label point-measure',
      edge: 'measurement-label edge-measure',
      diameter: 'measurement-label diameter-measure',
    };

    const color = colorMap[type] || 0x00ffff;

    // 3D 라인 생성
    const lineGeom = new THREE.BufferGeometry();
    const positions = new Float32Array([
      start.x, start.y, start.z,
      end.x, end.y, end.z,
    ]);
    lineGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const lineMat = new THREE.LineBasicMaterial({
      color,
      linewidth: 2,
      depthTest: false,
      transparent: true,
    });

    const line = new THREE.Line(lineGeom, lineMat);
    line.renderOrder = 998;
    this.scene.add(line);

    // 시작/끝 마커 (Sprite - 화면 고정 크기)
    const startMarker = createFixedMarker(start, color, 8);
    const endMarker = createFixedMarker(end, color, 8);
    this.scene.add(startMarker);
    this.scene.add(endMarker);

    // HTML 라벨
    const labelDiv = document.createElement('div');
    labelDiv.className = labelClassMap[type] || 'measurement-label';
    labelDiv.textContent = this.formatValue(length);
    labelDiv.dataset.measurementId = id;
    if (this.labelsContainer) {
      this.labelsContainer.appendChild(labelDiv);
    }

    const measurement = {
      id,
      type,
      start: start.clone(),
      end: end.clone(),
      length,
      midPoint,
      line,
      label: labelDiv,
      startMarker,
      endMarker,
      extras: [],  // 추가 scene 객체 (원 등)
    };

    this.measurements.push(measurement);
    return measurement;
  }

  /**
   * 측정 라벨 위치 업데이트 (매 프레임)
   * 마커 스케일은 Sprite sizeAttenuation:false로 자동 처리되므로 업데이트 불필요
   */
  updateLabels(camera) {
    const width = this.viewer.renderer.domElement.clientWidth;
    const height = this.viewer.renderer.domElement.clientHeight;

    for (const m of this.measurements) {
      if (!m.label || !m.midPoint) continue;

      const screenPos = m.midPoint.clone().project(camera);

      if (screenPos.z < 1) {
        const x = (screenPos.x + 1) / 2 * width;
        const y = (-screenPos.y + 1) / 2 * height;
        m.label.style.left = `${x}px`;
        m.label.style.top = `${y}px`;
        m.label.style.display = 'block';
      } else {
        m.label.style.display = 'none';
      }
    }
  }

  /**
   * 특정 측정 삭제
   */
  removeMeasurement(id) {
    const idx = this.measurements.findIndex(m => m.id === id);
    if (idx === -1) return;

    const m = this.measurements[idx];
    this._disposeMeasurement(m);
    this.measurements.splice(idx, 1);
  }

  /**
   * 모든 측정 삭제
   */
  clearAll() {
    for (const m of this.measurements) {
      this._disposeMeasurement(m);
    }
    this.measurements = [];
  }

  _disposeMeasurement(m) {
    if (m.line) {
      this.scene.remove(m.line);
      m.line.geometry.dispose();
      m.line.material.dispose();
    }
    if (m.startMarker) {
      this.scene.remove(m.startMarker);
      m.startMarker.material.dispose();
    }
    if (m.endMarker) {
      this.scene.remove(m.endMarker);
      m.endMarker.material.dispose();
    }
    if (m.label) {
      m.label.remove();
    }
    // 추가 scene 객체 (원 등) 정리
    if (m.extras) {
      for (const obj of m.extras) {
        this.scene.remove(obj);
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      }
    }
  }

  /** 측정 개수 반환 */
  get count() {
    return this.measurements.length;
  }

  dispose() {
    this.clearAll();
  }
}
