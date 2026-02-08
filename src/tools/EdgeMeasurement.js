/**
 * EdgeMeasurement - 1-click Edge 길이 측정
 * Feature Edge 추출, 체인 병합, 마우스 기반 Edge 선택
 */
import * as THREE from 'three';

export class EdgeMeasurement {
  constructor(viewer, measurementManager) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.mm = measurementManager;
    this.active = false;

    // Edge 데이터
    this.edgeData = [];
    this.meshList = [];
    this.hoveredEdge = null;
    this.highlightLine = null;

    // 설정
    this.edgeThreshold = 80;  // Feature edge 판별 각도

    // Binding
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onClick = this._onClick.bind(this);
  }

  activate() {
    if (this.active) return;
    this.active = true;
    this._extractEdgeData();
    this.viewer.renderer.domElement.style.cursor = 'crosshair';
    this.viewer.renderer.domElement.addEventListener('mousemove', this._onMouseMove);
    this.viewer.renderer.domElement.addEventListener('click', this._onClick);
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this._clearHighlight();
    this.hoveredEdge = null;
    this.viewer.renderer.domElement.style.cursor = '';
    this.viewer.renderer.domElement.removeEventListener('mousemove', this._onMouseMove);
    this.viewer.renderer.domElement.removeEventListener('click', this._onClick);
  }

  toggle() {
    if (this.active) this.deactivate();
    else this.activate();
    return this.active;
  }

  // ───── Edge Data Extraction ─────

  _extractEdgeData() {
    this.edgeData = [];
    this.meshList = [];
    const model = this.viewer.modelLoader.model;
    if (!model) return;

    model.traverse((child) => {
      if (child.isMesh && child.geometry) {
        this.meshList.push(child);

        const edgesGeom = new THREE.EdgesGeometry(child.geometry, this.edgeThreshold);
        const positions = edgesGeom.attributes.position.array;

        child.updateWorldMatrix(true, false);
        const matrix = child.matrixWorld;

        const edges = [];
        for (let i = 0; i < positions.length; i += 6) {
          const start = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
          const end = new THREE.Vector3(positions[i + 3], positions[i + 4], positions[i + 5]);
          start.applyMatrix4(matrix);
          end.applyMatrix4(matrix);
          edges.push({ start, end, length: start.distanceTo(end) });
        }

        if (edges.length > 0) {
          this.edgeData.push({ mesh: child, edges });
        }
        edgesGeom.dispose();
      }
    });
  }

  // ───── Edge Finding ─────

  _findClosestEdge(mouseX, mouseY) {
    const camera = this.viewer.cameraManager.getActiveCamera();
    const canvas = this.viewer.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const maxDistance = 15;

    let closestEdge = null;
    let closestDistance = Infinity;
    let closestDepth = Infinity;

    for (const data of this.edgeData) {
      for (const edge of data.edges) {
        const screenStart = edge.start.clone().project(camera);
        const screenEnd = edge.end.clone().project(camera);

        if (screenStart.z > 1 && screenEnd.z > 1) continue;

        const startX = (screenStart.x + 1) / 2 * width;
        const startY = (-screenStart.y + 1) / 2 * height;
        const endX = (screenEnd.x + 1) / 2 * width;
        const endY = (-screenEnd.y + 1) / 2 * height;

        const dist = this._distPointToSegment(mouseX, mouseY, startX, startY, endX, endY);

        if (dist < maxDistance) {
          const midPoint = new THREE.Vector3().addVectors(edge.start, edge.end).multiplyScalar(0.5);
          const edgeDepth = camera.position.distanceTo(midPoint);

          // 가려짐 체크
          if (!this._isEdgeVisible(edge, midPoint)) continue;

          if (dist < closestDistance ||
            (Math.abs(dist - closestDistance) < 3 && edgeDepth < closestDepth)) {
            closestDistance = dist;
            closestDepth = edgeDepth;
            closestEdge = edge;
          }
        }
      }
    }

    return closestEdge;
  }

  _isEdgeVisible(edge, midPoint) {
    const camera = this.viewer.cameraManager.getActiveCamera();

    // Section plane 체크
    const sectionMgr = this.viewer.sectionPlaneManager;
    if (sectionMgr) {
      const planes = sectionMgr.getClippingPlanes();
      for (const plane of planes) {
        if (plane.distanceToPoint(midPoint) < 0) return false;
      }
    }

    // Raycasting으로 가려짐 체크
    const dirToCamera = new THREE.Vector3().subVectors(camera.position, midPoint).normalize();
    const rayOrigin = midPoint.clone().add(dirToCamera.clone().multiplyScalar(0.01));
    const distToCamera = midPoint.distanceTo(camera.position);

    const testRay = new THREE.Raycaster(rayOrigin, dirToCamera, 0, distToCamera);
    const intersects = testRay.intersectObjects(this.meshList, false);

    if (intersects.length > 0) {
      if (intersects[0].distance < distToCamera * 0.9) {
        return false;
      }
    }

    return true;
  }

  _distPointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  // ───── Highlight ─────

  _highlightEdge(edge) {
    this._clearHighlight();
    if (!edge) return;

    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array([
      edge.start.x, edge.start.y, edge.start.z,
      edge.end.x, edge.end.y, edge.end.z,
    ]);
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.LineBasicMaterial({
      color: 0x00ff00,
      linewidth: 3,
      depthTest: false,
      transparent: true,
    });

    this.highlightLine = new THREE.Line(geom, mat);
    this.highlightLine.renderOrder = 999;
    this.scene.add(this.highlightLine);
  }

  _clearHighlight() {
    if (this.highlightLine) {
      this.scene.remove(this.highlightLine);
      this.highlightLine.geometry.dispose();
      this.highlightLine.material.dispose();
      this.highlightLine = null;
    }
  }

  // ───── Event Handlers ─────

  _onMouseMove(event) {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const edge = this._findClosestEdge(mouseX, mouseY);
    if (edge !== this.hoveredEdge) {
      this.hoveredEdge = edge;
      this._highlightEdge(edge);
    }
  }

  _onClick(event) {
    if (event.button !== 0) return;
    if (!this.hoveredEdge) return;

    this.mm.createMeasurement(
      this.hoveredEdge.start,
      this.hoveredEdge.end,
      'edge'
    );
  }

  dispose() {
    this.deactivate();
  }
}
