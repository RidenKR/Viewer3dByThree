/**
 * MeasurementManager - 측정 도구 공통 인프라
 * HTML overlay 기반 측정 라벨, 마커, 라인 관리
 */
import * as THREE from 'three';

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
   * @param {THREE.Vector3} start
   * @param {THREE.Vector3} end
   * @param {string} type - 'distance' | 'edge' | 'diameter'
   * @returns {object} measurement 객체
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

    // 시작/끝 마커
    const startMarker = this._createPointMarker(start, 0x00ff00);
    const endMarker = this._createPointMarker(end, 0xff4444);

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
    };

    this.measurements.push(measurement);
    return measurement;
  }

  /**
   * 단일 점 마커 생성
   */
  _createPointMarker(position, color) {
    const geometry = new THREE.SphereGeometry(0.5, 16, 16);
    const material = new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity: 0.8,
    });
    const marker = new THREE.Mesh(geometry, material);
    marker.position.copy(position);
    marker.renderOrder = 999;

    // 모델 크기에 비례한 스케일
    const modelLoader = this.viewer.modelLoader;
    if (modelLoader.modelBounds) {
      const size = modelLoader.modelBounds.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      marker.scale.setScalar(maxDim * 0.012);
    }

    this.scene.add(marker);
    return marker;
  }

  /**
   * 측정 라벨 위치 업데이트 (매 프레임)
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
   * @param {number} id
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
      m.startMarker.geometry.dispose();
      m.startMarker.material.dispose();
    }
    if (m.endMarker) {
      this.scene.remove(m.endMarker);
      m.endMarker.geometry.dispose();
      m.endMarker.material.dispose();
    }
    if (m.label) {
      m.label.remove();
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
