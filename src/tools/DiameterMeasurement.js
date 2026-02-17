/**
 * DiameterMeasurement - 3점 지름 측정
 * 3개의 점으로 외접원(circumscribed circle)을 계산하여 지름 표시
 */
import * as THREE from 'three';
import { createFixedMarker } from './MeasurementManager.js';

export class DiameterMeasurement {
  constructor(viewer, measurementManager) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.mm = measurementManager;
    this.active = false;

    // 수집 상태
    this.points = [];      // THREE.Vector3[]
    this.pointMarkers = []; // THREE.Mesh[]
    this.circleLines = [];  // 생성된 원 시각화

    // Edge snap 데이터
    this.edgeData = [];
    this.snapPoint = null;
    this.snapMarker = null;

    // Binding
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onClick = this._onClick.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  activate() {
    if (this.active) return;
    this.active = true;
    return new Promise(resolve => {
      requestAnimationFrame(() => setTimeout(() => {
        this._extractEdgeData();
        this.viewer.renderer.domElement.style.cursor = 'crosshair';
        this.viewer.renderer.domElement.addEventListener('mousemove', this._onMouseMove);
        this.viewer.renderer.domElement.addEventListener('click', this._onClick);
        window.addEventListener('keydown', this._onKeyDown);
        resolve();
      }, 0));
    });
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this._resetCollection();
    this._clearSnapMarker();
    this.viewer.renderer.domElement.style.cursor = '';
    this.viewer.renderer.domElement.removeEventListener('mousemove', this._onMouseMove);
    this.viewer.renderer.domElement.removeEventListener('click', this._onClick);
    window.removeEventListener('keydown', this._onKeyDown);
  }

  toggle() {
    if (this.active) this.deactivate();
    else this.activate();
    return this.active;
  }

  // ───── Edge Data Extraction ─────

  _extractEdgeData() {
    this.edgeData = [];
    const model = this.viewer.modelLoader.model;
    if (!model) return;

    // 총 정점 수 체크
    const MAX_VERTICES = 5_000_000;
    let totalVertices = 0;
    model.traverse((child) => {
      if (child.isMesh && child.geometry) {
        totalVertices += child.geometry.attributes.position.count;
      }
    });
    if (totalVertices > MAX_VERTICES) {
      console.warn(`[DiameterMeasurement] Model too large for edge extraction (${(totalVertices / 1e6).toFixed(1)}M vertices). Edge snapping disabled.`);
      this.tooLargeForEdges = true;
      return;
    }
    this.tooLargeForEdges = false;

    model.traverse((child) => {
      if (child.isMesh && child.geometry) {
        const edgesGeom = new THREE.EdgesGeometry(child.geometry, 80);
        const positions = edgesGeom.attributes.position.array;

        child.updateWorldMatrix(true, false);
        const matrix = child.matrixWorld;

        const edges = [];
        for (let i = 0; i < positions.length; i += 6) {
          const start = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
          const end = new THREE.Vector3(positions[i + 3], positions[i + 4], positions[i + 5]);
          start.applyMatrix4(matrix);
          end.applyMatrix4(matrix);
          edges.push({ start, end });
        }

        if (edges.length > 0) {
          this.edgeData.push({ edges });
        }
        edgesGeom.dispose();
      }
    });
  }

  // ───── Snap Point ─────

  _findSnapPoint(mouseX, mouseY) {
    const camera = this.viewer.cameraManager.getActiveCamera();
    const canvas = this.viewer.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const maxDistance = 20;

    let closestPoint = null;
    let closestDistance = Infinity;

    for (const data of this.edgeData) {
      for (const edge of data.edges) {
        const screenStart = edge.start.clone().project(camera);
        const screenEnd = edge.end.clone().project(camera);
        if (screenStart.z > 1 && screenEnd.z > 1) continue;

        const startX = (screenStart.x + 1) / 2 * width;
        const startY = (-screenStart.y + 1) / 2 * height;
        const endX = (screenEnd.x + 1) / 2 * width;
        const endY = (-screenEnd.y + 1) / 2 * height;

        // 끝점 우선 (vertex snap)
        const distToStart = Math.hypot(mouseX - startX, mouseY - startY);
        const distToEnd = Math.hypot(mouseX - endX, mouseY - endY);

        if (distToStart < maxDistance && distToStart < closestDistance && screenStart.z < 1) {
          closestPoint = edge.start.clone();
          closestDistance = distToStart;
        }
        if (distToEnd < maxDistance && distToEnd < closestDistance && screenEnd.z < 1) {
          closestPoint = edge.end.clone();
          closestDistance = distToEnd;
        }
      }
    }

    return closestPoint;
  }

  _updateSnapMarker(point) {
    if (!point) {
      if (this.snapMarker) this.snapMarker.visible = false;
      this.snapPoint = null;
      return;
    }

    this.snapPoint = point;

    if (!this.snapMarker) {
      this.snapMarker = createFixedMarker(point, 0xff6b35, 6);
      this.snapMarker.renderOrder = 1000;
      this.scene.add(this.snapMarker);
    }

    this.snapMarker.position.copy(point);
    this.snapMarker.visible = true;
  }

  _clearSnapMarker() {
    this.snapPoint = null;
    if (this.snapMarker) {
      this.scene.remove(this.snapMarker);
      this.snapMarker.material.dispose();
      this.snapMarker = null;
    }
  }

  // ───── Event Handlers ─────

  _onMouseMove(event) {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const point = this._findSnapPoint(mouseX, mouseY);
    this._updateSnapMarker(point);
  }

  _onClick(event) {
    if (event.button !== 0) return;
    if (!this.snapPoint) return;

    this.points.push(this.snapPoint.clone());
    this._addPointMarker(this.snapPoint, this.points.length);

    if (this.points.length === 3) {
      this._calculateCircle();
    }
  }

  _onKeyDown(event) {
    if (event.key === 'Escape') {
      this._resetCollection();
    }
  }

  // ───── Point Markers ─────

  _addPointMarker(position, index) {
    const colors = [0xff6b35, 0xff9800, 0xffdd57];
    const color = colors[(index - 1) % colors.length];

    const marker = createFixedMarker(position, color, 8);
    this.scene.add(marker);
    this.pointMarkers.push(marker);
  }

  // ───── Circle Calculation ─────

  _calculateCircle() {
    const p1 = this.points[0];
    const p2 = this.points[1];
    const p3 = this.points[2];

    const result = fitCircle3Points(p1, p2, p3);

    if (!result) {
      this._resetCollection();
      return;
    }

    // 모델 크기 대비 유효성 체크
    const modelBounds = this.viewer.modelLoader.modelBounds;
    if (modelBounds) {
      const size = modelBounds.getSize(new THREE.Vector3());
      const modelSize = Math.max(size.x, size.y, size.z);
      if (result.radius > modelSize) {
        this._resetCollection();
        return;
      }
    }

    // 원 시각화 생성
    const circleLine = this._createCircleVisualization(result.center, result.radius, result.normal);

    // 지름 측정 생성 (center를 통과하는 가상 선분)
    const diameter = result.radius * 2;
    // 지름의 양 끝점: 중심에서 반지름 방향
    const dir = new THREE.Vector3().subVectors(p1, result.center).normalize();
    const diamStart = result.center.clone().add(dir.clone().multiplyScalar(result.radius));
    const diamEnd = result.center.clone().add(dir.clone().multiplyScalar(-result.radius));

    const measurement = this.mm.createMeasurement(diamStart, diamEnd, 'diameter');
    measurement.extras.push(circleLine);

    // 수집 리셋 (계속 측정 가능)
    this._resetCollection();
  }

  _createCircleVisualization(center, radius, normal) {
    const segments = 64;
    const n = normal.clone().normalize();

    // 법선에 수직인 두 기저 벡터
    let u = new THREE.Vector3();
    if (Math.abs(n.x) < 0.9) {
      u.crossVectors(n, new THREE.Vector3(1, 0, 0));
    } else {
      u.crossVectors(n, new THREE.Vector3(0, 1, 0));
    }
    u.normalize();
    const v = new THREE.Vector3().crossVectors(n, u).normalize();

    const points = [];
    for (let i = 0; i <= segments; i++) {
      const theta = (2 * Math.PI * i) / segments;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      points.push(new THREE.Vector3(
        center.x + radius * (cos * u.x + sin * v.x),
        center.y + radius * (cos * u.y + sin * v.y),
        center.z + radius * (cos * u.z + sin * v.z)
      ));
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: 0x00e5ff,
      linewidth: 2,
      depthTest: false,
      transparent: true,
    });

    const circleLine = new THREE.Line(geometry, material);
    circleLine.renderOrder = 998;
    this.scene.add(circleLine);
    this.circleLines.push(circleLine);
    return circleLine;
  }

  _resetCollection() {
    this.points = [];

    // 점 마커 제거
    this.pointMarkers.forEach(m => {
      this.scene.remove(m);
      m.material.dispose();
    });
    this.pointMarkers = [];
  }

  dispose() {
    this.deactivate();
    this.circleLines.forEach(l => {
      this.scene.remove(l);
      l.geometry.dispose();
      l.material.dispose();
    });
    this.circleLines = [];
  }
}

// ───── 외접원 계산 (Barycentric Coordinates) ─────

function fitCircle3Points(p1, p2, p3) {
  const v1 = new THREE.Vector3().subVectors(p2, p1);
  const v2 = new THREE.Vector3().subVectors(p3, p1);

  // 법선 벡터 (외적)
  const n = new THREE.Vector3().crossVectors(v1, v2);
  const nLenSq = n.lengthSq();

  // collinear 체크
  if (nLenSq < 1e-12) return null;

  const d1 = v1.dot(v1);
  const d2 = v2.dot(v2);
  const d12 = v1.dot(v2);

  const denom = 2 * (d1 * d2 - d12 * d12);
  if (Math.abs(denom) < 1e-12) return null;

  const s = (d1 * d2 - d2 * d12) / denom;
  const t = (d1 * d2 - d1 * d12) / denom;

  const center = new THREE.Vector3(
    p1.x + s * v1.x + t * v2.x,
    p1.y + s * v1.y + t * v2.y,
    p1.z + s * v1.z + t * v2.z
  );

  const radius = center.distanceTo(p1);
  const normal = n.normalize();

  return { center, radius, normal };
}
