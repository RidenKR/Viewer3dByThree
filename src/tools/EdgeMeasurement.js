/**
 * EdgeMeasurement - 1-click Edge 길이 측정
 * Feature Edge 추출, Raycast-first 접근, 마우스 기반 Edge 선택
 *
 * 성능 최적화 전략:
 * 1. Raycast로 마우스 아래 mesh 표면을 먼저 찾음
 * 2. 히트된 mesh의 엣지만 검색 (336K → 수백 개로 축소)
 * 3. 히트 포인트 근처의 엣지만 스크린 거리 비교
 * 4. 50ms throttle로 mousemove 호출 빈도 제한
 */
import * as THREE from 'three';

export class EdgeMeasurement {
  constructor(viewer, measurementManager) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.mm = measurementManager;
    this.active = false;

    // Edge 데이터 (mesh별로 그룹화)
    this.edgeDataByMesh = new Map();  // mesh → [{start, end, length, midPoint}]
    this.meshList = [];
    this.hoveredEdge = null;
    this.highlightLine = null;

    // 설정
    this.edgeThreshold = 80;  // Feature edge 판별 각도
    this.searchRadius3D = 0;  // 3D 공간에서 히트 포인트 근처 엣지 검색 반경 (자동 계산)

    // Raycaster
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();

    // Throttle
    this._moveThrottle = false;

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
    this.edgeDataByMesh = new Map();
    this.meshList = [];
    const model = this.viewer.modelLoader.model;
    if (!model) return;

    let totalMeshes = 0, totalEdges = 0;
    model.traverse((child) => {
      if (child.isMesh && child.geometry) {
        this.meshList.push(child);
        totalMeshes++;

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
          const midPoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
          const edge = { start, end, length: start.distanceTo(end), midPoint };
          edges.push(edge);
        }

        totalEdges += edges.length;
        if (edges.length > 0) {
          this.edgeDataByMesh.set(child, edges);
        }
        edgesGeom.dispose();
      }
    });

    // 3D 검색 반경 계산: 모델 전체 바운딩 스피어의 2%
    const box = new THREE.Box3().setFromObject(model);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    this.searchRadius3D = sphere.radius * 0.02;

    console.log(`[EdgeMeasurement] Meshes: ${totalMeshes}, Total edges: ${totalEdges}, Search radius: ${this.searchRadius3D.toFixed(2)}`);
  }

  // ───── Raycast-first Edge Finding ─────

  _findClosestEdge(mouseX, mouseY) {
    const camera = this.viewer.cameraManager.getActiveCamera();
    const canvas = this.viewer.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const maxScreenDistance = 15; // 픽셀

    // 1단계: Raycast로 마우스 아래 mesh 표면 찾기
    this._mouse.x = (mouseX / width) * 2 - 1;
    this._mouse.y = -(mouseY / height) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, camera);

    const intersects = this._raycaster.intersectObjects(this.meshList, false);

    if (intersects.length === 0) {
      // 메쉬를 히트하지 못한 경우: 스크린 거리 기반 폴백 (비용 절감을 위해 제한적)
      return this._findEdgeByScreenFallback(mouseX, mouseY, camera, width, height, maxScreenDistance);
    }

    const hit = intersects[0];
    const hitPoint = hit.point;
    const hitMesh = hit.object;
    const hitDepth = hit.distance; // 카메라에서 히트 포인트까지 거리

    // 2단계: 히트된 mesh의 엣지만 검색
    const meshEdges = this.edgeDataByMesh.get(hitMesh);
    if (!meshEdges || meshEdges.length === 0) return null;

    // 3단계: 히트 포인트 근처의 엣지만 스크린 거리 비교
    const searchRadius = Math.max(this.searchRadius3D, hit.distance * 0.03);
    const searchRadiusSq = searchRadius * searchRadius;
    // 깊이 허용치: 히트 포인트보다 약간 앞(카메라쪽)까지만 허용
    const depthTolerance = searchRadius;

    const candidates = [];
    for (const edge of meshEdges) {
      // 3D 거리로 1차 필터링 (히트 포인트에서 너무 먼 엣지 제외)
      const distToMidSq = hitPoint.distanceToSquared(edge.midPoint);
      const distToStartSq = hitPoint.distanceToSquared(edge.start);
      const distToEndSq = hitPoint.distanceToSquared(edge.end);
      const minDistSq = Math.min(distToMidSq, distToStartSq, distToEndSq);

      if (minDistSq > searchRadiusSq) continue;

      // 깊이 필터: 엣지 midPoint가 히트 포인트보다 뒤쪽(카메라 반대)이면 제외
      const edgeDepth = camera.position.distanceTo(edge.midPoint);
      if (edgeDepth > hitDepth + depthTolerance) continue;

      // 2D 스크린 거리 계산
      const screenStart = edge.start.clone().project(camera);
      const screenEnd = edge.end.clone().project(camera);

      if (screenStart.z > 1 && screenEnd.z > 1) continue;

      const startX = (screenStart.x + 1) / 2 * width;
      const startY = (-screenStart.y + 1) / 2 * height;
      const endX = (screenEnd.x + 1) / 2 * width;
      const endY = (-screenEnd.y + 1) / 2 * height;

      const dist = this._distPointToSegment(mouseX, mouseY, startX, startY, endX, endY);

      if (dist < maxScreenDistance) {
        candidates.push({ edge, dist });
      }
    }

    if (candidates.length === 0) {
      // 히트 mesh에서 가까운 엣지를 못 찾으면, 다른 히트 mesh도 시도
      for (let i = 1; i < Math.min(intersects.length, 3); i++) {
        const altHit = intersects[i];
        const altEdges = this.edgeDataByMesh.get(altHit.object);
        if (!altEdges) continue;

        const altRadius = Math.max(this.searchRadius3D, altHit.distance * 0.03);
        const altRadiusSq = altRadius * altRadius;
        const altDepthTolerance = altRadius;

        for (const edge of altEdges) {
          const dSq = Math.min(
            altHit.point.distanceToSquared(edge.midPoint),
            altHit.point.distanceToSquared(edge.start),
            altHit.point.distanceToSquared(edge.end)
          );
          if (dSq > altRadiusSq) continue;

          // 깊이 필터
          const altEdgeDepth = camera.position.distanceTo(edge.midPoint);
          if (altEdgeDepth > altHit.distance + altDepthTolerance) continue;

          const ss = edge.start.clone().project(camera);
          const se = edge.end.clone().project(camera);
          if (ss.z > 1 && se.z > 1) continue;

          const sx = (ss.x + 1) / 2 * width;
          const sy = (-ss.y + 1) / 2 * height;
          const ex = (se.x + 1) / 2 * width;
          const ey = (-se.y + 1) / 2 * height;

          const dist = this._distPointToSegment(mouseX, mouseY, sx, sy, ex, ey);
          if (dist < maxScreenDistance) {
            candidates.push({ edge, dist });
          }
        }
        if (candidates.length > 0) break;
      }
    }

    if (candidates.length === 0) return null;

    // 가장 가까운 엣지 반환 (스크린 거리 기준)
    candidates.sort((a, b) => a.dist - b.dist);
    return candidates[0].edge;
  }

  /**
   * 폴백: mesh를 히트하지 못한 경우 (예: 모델 가장자리 근처)
   * Frustum 내 엣지 중 마우스에 가까운 것을 찾되, 최대 검색 개수 제한
   */
  _findEdgeByScreenFallback(mouseX, mouseY, camera, width, height, maxScreenDistance) {
    // 마우스 ray 방향으로부터 가장 가까운 엣지를 찾기 위해
    // ray와 3D 거리가 가까운 mesh의 엣지만 검색
    const rayOrigin = this._raycaster.ray.origin;
    const rayDir = this._raycaster.ray.direction;

    let bestEdge = null;
    let bestDist = maxScreenDistance;

    // 각 mesh의 바운딩 스피어와 ray 거리 비교
    for (const [mesh, edges] of this.edgeDataByMesh) {
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();

      // mesh의 월드 바운딩 스피어
      const worldSphere = mesh.geometry.boundingSphere.clone();
      worldSphere.applyMatrix4(mesh.matrixWorld);

      // ray와 sphere 중심 거리
      const closestPointOnRay = new THREE.Vector3();
      this._raycaster.ray.closestPointToPoint(worldSphere.center, closestPointOnRay);
      const distToRay = closestPointOnRay.distanceTo(worldSphere.center);

      // sphere 반경의 1.5배보다 멀면 스킵
      if (distToRay > worldSphere.radius * 1.5) continue;

      for (const edge of edges) {
        const screenStart = edge.start.clone().project(camera);
        const screenEnd = edge.end.clone().project(camera);
        if (screenStart.z > 1 && screenEnd.z > 1) continue;

        const startX = (screenStart.x + 1) / 2 * width;
        const startY = (-screenStart.y + 1) / 2 * height;
        const endX = (screenEnd.x + 1) / 2 * width;
        const endY = (-screenEnd.y + 1) / 2 * height;

        const dist = this._distPointToSegment(mouseX, mouseY, startX, startY, endX, endY);
        if (dist < bestDist) {
          // 가려짐 체크
          if (this._isEdgeVisible(edge, edge.midPoint)) {
            bestDist = dist;
            bestEdge = edge;
          }
        }
      }
    }

    return bestEdge;
  }

  _isEdgeVisible(edge, midPoint) {
    // Section plane 체크
    const sectionMgr = this.viewer.sectionPlaneManager;
    if (sectionMgr) {
      const planes = sectionMgr.getClippingPlanes();
      for (const plane of planes) {
        if (plane.distanceToPoint(midPoint) < 0) return false;
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
    // 50ms throttle
    if (this._moveThrottle) return;
    this._moveThrottle = true;
    setTimeout(() => { this._moveThrottle = false; }, 50);

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
    this.edgeDataByMesh.clear();
    this.meshList = [];
  }
}
