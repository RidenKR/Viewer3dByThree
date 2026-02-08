/**
 * Diameter2Point - 2점 지름 측정
 * 2개의 점을 지름의 양 끝점으로 사용하여 지름 및 원 시각화
 */
import * as THREE from 'three';

export class Diameter2Point {
  constructor(viewer, measurementManager) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.mm = measurementManager;
    this.active = false;

    // 수집 상태
    this.firstPoint = null;
    this.firstMarker = null;
    this.tempLine = null;
    this.circleLines = [];

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
    this._extractEdgeData();
    this.viewer.renderer.domElement.style.cursor = 'crosshair';
    this.viewer.renderer.domElement.addEventListener('mousemove', this._onMouseMove);
    this.viewer.renderer.domElement.addEventListener('click', this._onClick);
    window.addEventListener('keydown', this._onKeyDown);
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this._clearTempState();
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

  // ───── Snap Point (vertex 우선) ─────

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
      const geom = new THREE.SphereGeometry(0.5, 16, 16);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00e5ff,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      });
      this.snapMarker = new THREE.Mesh(geom, mat);
      this.snapMarker.renderOrder = 1000;

      const modelBounds = this.viewer.modelLoader.modelBounds;
      if (modelBounds) {
        const size = modelBounds.getSize(new THREE.Vector3());
        this.snapMarker.scale.setScalar(Math.max(size.x, size.y, size.z) * 0.015);
      }
      this.scene.add(this.snapMarker);
    }

    this.snapMarker.position.copy(point);
    this.snapMarker.visible = true;
  }

  _clearSnapMarker() {
    this.snapPoint = null;
    if (this.snapMarker) {
      this.scene.remove(this.snapMarker);
      this.snapMarker.geometry.dispose();
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

    // 첫 번째 점 선택 후 임시 라인
    if (this.firstPoint && point) {
      this._updateTempLine(this.firstPoint, point);
    } else if (this.tempLine) {
      this.tempLine.visible = false;
    }
  }

  _onClick(event) {
    if (event.button !== 0) return;
    if (!this.snapPoint) return;

    if (!this.firstPoint) {
      this.firstPoint = this.snapPoint.clone();
      this.firstMarker = this._createMarker(this.firstPoint, 0x00e5ff);
    } else {
      const secondPoint = this.snapPoint.clone();
      this._createDiameterMeasurement(this.firstPoint, secondPoint);
      this._clearTempState();
    }
  }

  _onKeyDown(event) {
    if (event.key === 'Escape') {
      this._clearTempState();
    }
  }

  // ───── Diameter Measurement ─────

  _createDiameterMeasurement(p1, p2) {
    // 중심점 = 두 점의 중점
    const center = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
    const diameter = p1.distanceTo(p2);
    const radius = diameter / 2;

    // 원의 평면 법선 결정
    const normal = this._determineCircleNormal(p1, p2);

    // 원 시각화
    this._createCircleVisualization(center, radius, normal);

    // 측정 생성
    this.mm.createMeasurement(p1, p2, 'diameter');
  }

  _determineCircleNormal(p1, p2) {
    const diamVec = new THREE.Vector3().subVectors(p2, p1).normalize();
    const camera = this.viewer.cameraManager.getActiveCamera();
    const viewDir = new THREE.Vector3().subVectors(
      this.viewer.cameraManager.controls.target,
      camera.position
    ).normalize();

    // 카메라 시선 방향에서 지름 방향 성분 제거
    const proj = diamVec.clone().multiplyScalar(viewDir.dot(diamVec));
    const perpView = new THREE.Vector3().subVectors(viewDir, proj);
    const perpLen = perpView.length();

    if (perpLen < 1e-6) {
      // 카메라가 지름과 같은 방향 → up 벡터 사용
      const up = camera.up.clone().normalize();
      return new THREE.Vector3().crossVectors(diamVec, up).normalize();
    }

    return new THREE.Vector3().crossVectors(diamVec, perpView.normalize()).normalize();
  }

  _createCircleVisualization(center, radius, normal) {
    const segments = 64;
    const n = normal.clone().normalize();

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
      points.push(new THREE.Vector3(
        center.x + radius * (Math.cos(theta) * u.x + Math.sin(theta) * v.x),
        center.y + radius * (Math.cos(theta) * u.y + Math.sin(theta) * v.y),
        center.z + radius * (Math.cos(theta) * u.z + Math.sin(theta) * v.z)
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
  }

  // ───── Temp Visuals ─────

  _createMarker(position, color) {
    const geom = new THREE.SphereGeometry(0.5, 16, 16);
    const mat = new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity: 0.8,
    });
    const marker = new THREE.Mesh(geom, mat);
    marker.position.copy(position);
    marker.renderOrder = 999;

    const modelBounds = this.viewer.modelLoader.modelBounds;
    if (modelBounds) {
      const size = modelBounds.getSize(new THREE.Vector3());
      marker.scale.setScalar(Math.max(size.x, size.y, size.z) * 0.015);
    }

    this.scene.add(marker);
    return marker;
  }

  _updateTempLine(start, end) {
    if (!this.tempLine) {
      const geom = new THREE.BufferGeometry();
      const positions = new Float32Array(6);
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      const mat = new THREE.LineDashedMaterial({
        color: 0x00e5ff,
        dashSize: 3,
        gapSize: 2,
        depthTest: false,
        transparent: true,
        opacity: 0.7,
      });

      this.tempLine = new THREE.Line(geom, mat);
      this.tempLine.renderOrder = 997;
      this.scene.add(this.tempLine);
    }

    const pos = this.tempLine.geometry.attributes.position.array;
    pos[0] = start.x; pos[1] = start.y; pos[2] = start.z;
    pos[3] = end.x; pos[4] = end.y; pos[5] = end.z;
    this.tempLine.geometry.attributes.position.needsUpdate = true;
    this.tempLine.computeLineDistances();
    this.tempLine.visible = true;
  }

  _clearTempState() {
    this.firstPoint = null;

    if (this.firstMarker) {
      this.scene.remove(this.firstMarker);
      this.firstMarker.geometry.dispose();
      this.firstMarker.material.dispose();
      this.firstMarker = null;
    }

    if (this.tempLine) {
      this.scene.remove(this.tempLine);
      this.tempLine.geometry.dispose();
      this.tempLine.material.dispose();
      this.tempLine = null;
    }
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
