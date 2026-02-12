/**
 * DistanceMeasurement - 2점 거리 측정 (Edge snap 지원)
 *
 * 성능 최적화:
 * - Raycast-first: mesh 표면 히트 → 근처 엣지 끝점/엣지 위 점만 검색
 * - 50ms throttle
 * - mesh별 엣지 그룹화 (Map)
 */
import * as THREE from 'three';
import { createFixedMarker } from './MeasurementManager.js';

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

    // Edge 데이터 (mesh별 그룹화)
    this.edgeDataByMesh = new Map();
    this.meshList = [];
    this.searchRadius3D = 0;

    // Raycaster
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();

    // Throttle
    this._moveThrottle = false;

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
    this.edgeDataByMesh = new Map();
    this.meshList = [];
    const model = this.viewer.modelLoader.model;
    if (!model) return;

    let totalEdges = 0;
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
          const midPoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
          edges.push({ start, end, length: start.distanceTo(end), midPoint });
        }

        totalEdges += edges.length;
        if (edges.length > 0) {
          this.edgeDataByMesh.set(child, edges);
        }
        edgesGeom.dispose();
      }
    });

    // 3D 검색 반경: 모델 바운딩 스피어의 2%
    const box = new THREE.Box3().setFromObject(model);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    this.searchRadius3D = sphere.radius * 0.02;
  }

  // ───── Snap Point (Raycast-first) ─────

  _findSnapPoint(mouseX, mouseY) {
    const camera = this.viewer.cameraManager.getActiveCamera();
    const canvas = this.viewer.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const endpointPriority = 10; // 끝점 우선 범위 (px)
    const maxEdgeDist = 20; // 엣지 위 점 최대 거리 (px)

    // 1단계: Raycast로 표면 히트
    this._mouse.x = (mouseX / width) * 2 - 1;
    this._mouse.y = -(mouseY / height) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, camera);

    const intersects = this._raycaster.intersectObjects(this.meshList, false);

    if (intersects.length === 0) {
      return null;
    }

    const hit = intersects[0];
    const hitPoint = hit.point;
    const hitMesh = hit.object;
    const hitDepth = hit.distance;

    // 2단계: 히트된 mesh의 엣지 중 근처 것만 검색
    const meshEdges = this.edgeDataByMesh.get(hitMesh);
    if (!meshEdges || meshEdges.length === 0) {
      // 엣지 없는 mesh → 스냅 불가
      return null;
    }

    const searchRadius = Math.max(this.searchRadius3D, hitDepth * 0.03);
    const searchRadiusSq = searchRadius * searchRadius;
    const depthTolerance = searchRadius;

    let closestPoint = null;
    let closestDistance = Infinity;
    let isEndpoint = false;

    for (const edge of meshEdges) {
      // 3D 거리로 1차 필터링
      const distToMidSq = hitPoint.distanceToSquared(edge.midPoint);
      const distToStartSq = hitPoint.distanceToSquared(edge.start);
      const distToEndSq = hitPoint.distanceToSquared(edge.end);
      const minDistSq = Math.min(distToMidSq, distToStartSq, distToEndSq);
      if (minDistSq > searchRadiusSq) continue;

      // 깊이 필터
      const edgeDepth = camera.position.distanceTo(edge.midPoint);
      if (edgeDepth > hitDepth + depthTolerance) continue;

      // 스크린 좌표 변환
      const screenStart = edge.start.clone().project(camera);
      const screenEnd = edge.end.clone().project(camera);
      if (screenStart.z > 1 && screenEnd.z > 1) continue;

      const startX = (screenStart.x + 1) / 2 * width;
      const startY = (-screenStart.y + 1) / 2 * height;
      const endX = (screenEnd.x + 1) / 2 * width;
      const endY = (-screenEnd.y + 1) / 2 * height;

      // 끝점 우선 검사
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

      // Edge 위의 점 (끝점 없을 때만)
      if (!isEndpoint) {
        const distToEdge = this._distPointToSegment(mouseX, mouseY, startX, startY, endX, endY);
        if (distToEdge < maxEdgeDist && distToEdge < closestDistance) {
          const t = this._getProjectionT(mouseX, mouseY, startX, startY, endX, endY);
          closestPoint = new THREE.Vector3().lerpVectors(edge.start, edge.end, t);
          closestDistance = distToEdge;
        }
      }
    }

    // 대체 히트 mesh 검색
    if (!closestPoint) {
      for (let i = 1; i < Math.min(intersects.length, 3); i++) {
        const altHit = intersects[i];
        const altEdges = this.edgeDataByMesh.get(altHit.object);
        if (!altEdges) continue;

        const altRadius = Math.max(this.searchRadius3D, altHit.distance * 0.03);
        const altRadiusSq = altRadius * altRadius;

        for (const edge of altEdges) {
          const dSq = Math.min(
            altHit.point.distanceToSquared(edge.midPoint),
            altHit.point.distanceToSquared(edge.start),
            altHit.point.distanceToSquared(edge.end)
          );
          if (dSq > altRadiusSq) continue;

          const ss = edge.start.clone().project(camera);
          const se = edge.end.clone().project(camera);
          if (ss.z > 1 && se.z > 1) continue;

          const sx = (ss.x + 1) / 2 * width;
          const sy = (-ss.y + 1) / 2 * height;
          const ex = (se.x + 1) / 2 * width;
          const ey = (-se.y + 1) / 2 * height;

          const distToStart = Math.hypot(mouseX - sx, mouseY - sy);
          if (distToStart < endpointPriority && ss.z < 1 && distToStart < closestDistance) {
            closestPoint = edge.start.clone();
            closestDistance = distToStart;
          }

          const distToEnd = Math.hypot(mouseX - ex, mouseY - ey);
          if (distToEnd < endpointPriority && se.z < 1 && distToEnd < closestDistance) {
            closestPoint = edge.end.clone();
            closestDistance = distToEnd;
          }
        }
        if (closestPoint) break;
      }
    }

    // 엣지 근처에 없으면 스냅 불가
    return closestPoint || null;
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
      this.snapMarker = createFixedMarker(point, 0x00ff00, 6);
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
    // 50ms throttle
    if (this._moveThrottle) return;
    this._moveThrottle = true;
    setTimeout(() => { this._moveThrottle = false; }, 50);

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
    const marker = createFixedMarker(position, color, 8);
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
    this.edgeDataByMesh.clear();
    this.meshList = [];
  }
}
