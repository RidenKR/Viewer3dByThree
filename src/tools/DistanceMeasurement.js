/**
 * DistanceMeasurement - 2점 거리 측정 (Edge snap 지원)
 */
import * as THREE from 'three';

export class DistanceMeasurement {
  constructor(viewer, measurementManager) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.mm = measurementManager;
    this.active = false;

    // State
    this.firstPoint = null;
    this.firstMarker = null;
    this.tempLine = null;
    this.snapPoint = null;
    this.snapMarker = null;

    // Edge 데이터 (Edge snap용)
    this.edgeData = [];
    this.meshList = [];

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
    if (this.active) {
      this.deactivate();
    } else {
      this.activate();
    }
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
          edges.push({ start, end, length: start.distanceTo(end) });
        }

        if (edges.length > 0) {
          this.edgeData.push({ mesh: child, edges });
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
    const endpointPriority = 10;

    let closestPoint = null;
    let closestDistance = Infinity;
    let isEndpoint = false;

    for (const data of this.edgeData) {
      for (const edge of data.edges) {
        const screenStart = edge.start.clone().project(camera);
        const screenEnd = edge.end.clone().project(camera);

        if (screenStart.z > 1 && screenEnd.z > 1) continue;

        const startX = (screenStart.x + 1) / 2 * width;
        const startY = (-screenStart.y + 1) / 2 * height;
        const endX = (screenEnd.x + 1) / 2 * width;
        const endY = (-screenEnd.y + 1) / 2 * height;

        // 끝점 우선
        const distToStart = Math.hypot(mouseX - startX, mouseY - startY);
        const distToEnd = Math.hypot(mouseX - endX, mouseY - endY);

        if (distToStart < endpointPriority && screenStart.z < 1) {
          if (distToStart < closestDistance || !isEndpoint) {
            closestPoint = edge.start.clone();
            closestDistance = distToStart;
            isEndpoint = true;
          }
        }

        if (distToEnd < endpointPriority && screenEnd.z < 1) {
          if (distToEnd < closestDistance || !isEndpoint) {
            closestPoint = edge.end.clone();
            closestDistance = distToEnd;
            isEndpoint = true;
          }
        }

        // Edge 위의 점 (끝점 없을 때)
        if (!isEndpoint) {
          const distToEdge = this._distPointToSegment(mouseX, mouseY, startX, startY, endX, endY);
          if (distToEdge < maxDistance && distToEdge < closestDistance) {
            const t = this._getProjectionT(mouseX, mouseY, startX, startY, endX, endY);
            closestPoint = new THREE.Vector3().lerpVectors(edge.start, edge.end, t);
            closestDistance = distToEdge;
          }
        }
      }
    }

    return closestPoint;
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

  _getProjectionT(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return 0;
    return Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  }

  // ───── Snap Marker ─────

  _updateSnapMarker(point) {
    if (!point) {
      this._clearSnapMarker();
      return;
    }

    this.snapPoint = point;

    if (!this.snapMarker) {
      const geom = new THREE.SphereGeometry(0.5, 16, 16);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00ff00,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      });
      this.snapMarker = new THREE.Mesh(geom, mat);
      this.snapMarker.renderOrder = 1000;

      const modelBounds = this.viewer.modelLoader.modelBounds;
      if (modelBounds) {
        const size = modelBounds.getSize(new THREE.Vector3());
        const scale = Math.max(size.x, size.y, size.z) * 0.015;
        this.snapMarker.scale.setScalar(scale);
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
      // 첫 번째 점
      this.firstPoint = this.snapPoint.clone();
      this.firstMarker = this._createTempMarker(this.firstPoint, 0x00ff00);
      if (this.snapMarker) this.snapMarker.visible = false;
    } else {
      // 두 번째 점 → 측정 생성
      const secondPoint = this.snapPoint.clone();

      // Shift 키: 축 정렬
      if (event.shiftKey) {
        this._alignToAxis(this.firstPoint, secondPoint);
      }

      this.mm.createMeasurement(this.firstPoint, secondPoint, 'distance');
      this._clearTempState();
    }
  }

  _onKeyDown(event) {
    if (event.key === 'Escape' && this.firstPoint) {
      this._clearTempState();
    }
  }

  // ───── Temp Visuals ─────

  _createTempMarker(position, color) {
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
      marker.scale.setScalar(Math.max(size.x, size.y, size.z) * 0.02);
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
        color: 0x00ffff,
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

  /** Shift+클릭 시 축 정렬 */
  _alignToAxis(start, end) {
    const dx = Math.abs(end.x - start.x);
    const dy = Math.abs(end.y - start.y);
    const dz = Math.abs(end.z - start.z);

    if (dx >= dy && dx >= dz) {
      end.y = start.y;
      end.z = start.z;
    } else if (dy >= dx && dy >= dz) {
      end.x = start.x;
      end.z = start.z;
    } else {
      end.x = start.x;
      end.y = start.y;
    }
  }

  dispose() {
    this.deactivate();
    this._clearSnapMarker();
  }
}
