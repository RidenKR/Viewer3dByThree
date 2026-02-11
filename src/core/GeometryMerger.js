/**
 * GeometryMerger - Draw call 최적화를 위한 기하 병합
 *
 * 전략: Hybrid Merge
 * - 같은 머티리얼을 공유하는 메시들의 기하를 병합하여 draw call 감소
 * - 원본 메시는 visible=false로 유지 (Raycaster는 visible 무시 → 측정 도구 정상 동작)
 * - 병합 메시만 렌더링에 사용
 *
 * 성능: clone() 없이 직접 buffer 복사 + matrix 변환으로 고속 병합
 * - 41,696 메시 기준: mergeGeometries(clone+applyMatrix4) → 362초
 * - fastMerge (direct buffer copy) → 수 초 이내 목표
 */
import * as THREE from 'three';

// 한 번에 처리할 메시 수 (이 단위마다 메인 스레드에 양보)
const YIELD_INTERVAL = 100;

export class GeometryMerger {
  constructor(scene) {
    this.scene = scene;
    this.mergedMeshes = [];
    this.mergedEdges = null;
    this.originalMeshCount = 0;
    this.mergedMeshCount = 0;
    this.isMerged = false;
  }

  // ───── Public API ─────

  /**
   * 모델의 메시를 머티리얼별로 병합
   */
  async mergeModel(model, onProgress) {
    this.dispose();

    let meshCount = 0;
    model.traverse(child => { if (child.isMesh) meshCount++; });
    if (meshCount <= 3) {
      console.log(`[GeometryMerger] Skip merge: only ${meshCount} meshes`);
      return;
    }

    const startTime = performance.now();
    const groups = this._groupMeshesByMaterial(model);
    this.originalMeshCount = 0;

    let processed = 0;
    const total = groups.size;

    for (const [key, { material, meshes }] of groups) {
      this.originalMeshCount += meshes.length;

      if (meshes.length === 1) {
        processed++;
        onProgress?.(processed / total);
        continue;
      }

      const merged = await this._fastMerge(meshes);

      if (merged) {
        const clonedMat = material.clone();
        const mergedMesh = new THREE.Mesh(merged, clonedMat);
        mergedMesh.frustumCulled = false;
        mergedMesh.name = `merged_${key}`;
        this.scene.add(mergedMesh);
        this.mergedMeshes.push(mergedMesh);

        for (const mesh of meshes) {
          mesh.visible = false;
        }
      }

      processed++;
      onProgress?.(processed / total);
    }

    this.mergedMeshCount = this.mergedMeshes.length;
    this.isMerged = this.mergedMeshes.length > 0;

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
    console.log(
      `[GeometryMerger] ${this.originalMeshCount} meshes → ${this.mergedMeshCount} merged groups ` +
      `(${((1 - this.mergedMeshCount / Math.max(1, this.originalMeshCount)) * 100).toFixed(1)}% reduction, ${elapsed}s)`
    );
  }

  /**
   * 모든 엣지를 단일 LineSegments로 병합 (비동기)
   */
  async createMergedEdges(model, thresholdAngle = 80) {
    this.disposeMergedEdges();

    // 1단계: 전체 엣지 포지션 수를 미리 계산 → 한번에 Float32Array 할당
    const meshes = [];
    model.traverse((child) => {
      if (child.isMesh && child.geometry) meshes.push(child);
    });

    // EdgesGeometry 생성 + 포지션 수집 (비동기)
    const edgeArrays = [];
    let totalFloats = 0;

    for (let i = 0; i < meshes.length; i++) {
      const child = meshes[i];
      const edgesGeom = new THREE.EdgesGeometry(child.geometry, thresholdAngle);
      const pos = edgesGeom.attributes.position.array;

      if (pos.length > 0) {
        child.updateWorldMatrix(true, false);
        edgeArrays.push({ positions: pos, matrix: child.matrixWorld.clone() });
        totalFloats += pos.length;
      }
      edgesGeom.dispose();

      if ((i + 1) % YIELD_INTERVAL === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (totalFloats === 0) return null;

    // 2단계: 단일 buffer에 변환하며 복사
    const merged = new Float32Array(totalFloats);
    const v = new THREE.Vector3();
    let offset = 0;

    for (let a = 0; a < edgeArrays.length; a++) {
      const { positions, matrix } = edgeArrays[a];
      for (let i = 0; i < positions.length; i += 3) {
        v.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(matrix);
        merged[offset++] = v.x;
        merged[offset++] = v.y;
        merged[offset++] = v.z;
      }

      if ((a + 1) % YIELD_INTERVAL === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(merged, 3));

    const material = new THREE.LineBasicMaterial({
      color: 0x000000,
      linewidth: 1,
      transparent: true,
      opacity: 0.8,
    });

    this.mergedEdges = new THREE.LineSegments(geometry, material);
    this.mergedEdges.name = 'merged_edges';
    this.scene.add(this.mergedEdges);

    console.log(`[GeometryMerger] Edges merged: ${totalFloats / 6} edge segments → 1 LineSegments`);
    return this.mergedEdges;
  }

  // ───── Visibility / Material Control ─────

  setMergedVisible(visible) {
    for (const mesh of this.mergedMeshes) mesh.visible = visible;
  }

  setMergedWireframe(wireframe) {
    for (const mesh of this.mergedMeshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach(mat => {
        mat.wireframe = wireframe;
        mat.transparent = wireframe;
        mat.opacity = wireframe ? 0.3 : 1.0;
        mat.needsUpdate = true;
      });
    }
  }

  setMergedClipping(planes) {
    for (const mesh of this.mergedMeshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach(mat => {
        mat.clippingPlanes = planes || [];
        mat.needsUpdate = true;
      });
    }
  }

  setMergedColor(hexColor) {
    for (const mesh of this.mergedMeshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach(mat => {
        if (hexColor) mat.color.set(hexColor);
        mat.needsUpdate = true;
      });
    }
  }

  setEdgesVisible(visible) {
    if (this.mergedEdges) this.mergedEdges.visible = visible;
  }

  setEdgeClipping(planes) {
    if (this.mergedEdges) {
      this.mergedEdges.material.clippingPlanes = planes || [];
      this.mergedEdges.material.needsUpdate = true;
    }
  }

  getMergeStats() {
    return {
      originalMeshes: this.originalMeshCount,
      mergedGroups: this.mergedMeshCount,
      isMerged: this.isMerged,
    };
  }

  disposeMergedEdges() {
    if (this.mergedEdges) {
      this.scene.remove(this.mergedEdges);
      this.mergedEdges.geometry.dispose();
      this.mergedEdges.material.dispose();
      this.mergedEdges = null;
    }
  }

  dispose() {
    for (const mesh of this.mergedMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach(m => m.dispose());
      } else {
        mesh.material.dispose();
      }
    }
    this.mergedMeshes = [];
    this.disposeMergedEdges();
    this.isMerged = false;
    this.originalMeshCount = 0;
    this.mergedMeshCount = 0;
  }

  // ───── Fast Merge (inline 행렬 곱으로 초고속 병합) ─────

  /**
   * 고속 기하 병합
   * - clone() 없음
   * - THREE.Vector3 객체 사용 없음
   * - 행렬 원소를 직접 꺼내서 inline 곱셈 (메서드 호출 오버헤드 제거)
   */
  async _fastMerge(meshes) {
    // 1단계: 전체 크기 계산
    let totalVertices = 0;
    let totalIndices = 0;
    let allIndexed = true;

    for (const mesh of meshes) {
      const geom = mesh.geometry;
      totalVertices += geom.attributes.position.count;
      if (geom.index) {
        totalIndices += geom.index.count;
      } else {
        allIndexed = false;
      }
    }

    const useIndex = allIndexed;

    // 2단계: 버퍼 할당
    const posOut = new Float32Array(totalVertices * 3);
    const normOut = new Float32Array(totalVertices * 3);
    const idxOut = useIndex ? new Uint32Array(totalIndices) : null;

    let vOff = 0;   // vertex float offset
    let iOff = 0;   // index offset
    let vCount = 0;  // cumulative vertex count (for index offset)

    // 3단계: 각 mesh의 buffer를 inline 행렬 곱으로 복사
    for (let m = 0; m < meshes.length; m++) {
      const mesh = meshes[m];
      const geom = mesh.geometry;
      mesh.updateWorldMatrix(true, false);

      // Matrix4 원소를 로컬 변수로 추출 (column-major)
      const me = mesh.matrixWorld.elements;
      const m00 = me[0], m01 = me[4], m02 = me[8],  m03 = me[12];
      const m10 = me[1], m11 = me[5], m12 = me[9],  m13 = me[13];
      const m20 = me[2], m21 = me[6], m22 = me[10], m23 = me[14];

      const srcPos = geom.attributes.position.array;
      const srcNorm = geom.attributes.normal?.array;
      const srcCount = geom.attributes.position.count;

      // Position: P' = M * P (affine, w=1)
      for (let i = 0; i < srcPos.length; i += 3) {
        const x = srcPos[i], y = srcPos[i + 1], z = srcPos[i + 2];
        posOut[vOff + i]     = m00 * x + m01 * y + m02 * z + m03;
        posOut[vOff + i + 1] = m10 * x + m11 * y + m12 * z + m13;
        posOut[vOff + i + 2] = m20 * x + m21 * y + m22 * z + m23;
      }

      // Normal: N' = normalMatrix * N (3x3, no translate)
      // normalMatrix = transpose(inverse(upperLeft3x3(M)))
      // 대부분의 CAD 모델은 uniform scale이므로 upperLeft3x3만 사용해도 충분
      // (non-uniform scale인 경우에만 정확한 normalMatrix 필요)
      if (srcNorm) {
        for (let i = 0; i < srcNorm.length; i += 3) {
          const nx = srcNorm[i], ny = srcNorm[i + 1], nz = srcNorm[i + 2];
          const rx = m00 * nx + m01 * ny + m02 * nz;
          const ry = m10 * nx + m11 * ny + m12 * nz;
          const rz = m20 * nx + m21 * ny + m22 * nz;
          // normalize
          const len = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
          normOut[vOff + i]     = rx / len;
          normOut[vOff + i + 1] = ry / len;
          normOut[vOff + i + 2] = rz / len;
        }
      }

      // Index: offset 적용하며 복사
      if (useIndex && geom.index) {
        const srcIdx = geom.index.array;
        for (let i = 0; i < srcIdx.length; i++) {
          idxOut[iOff + i] = srcIdx[i] + vCount;
        }
        iOff += srcIdx.length;
      }

      vOff += srcPos.length;
      vCount += srcCount;

      // yield (500개 메시마다 — inline 곱셈이 빠르므로 간격 늘림)
      if ((m + 1) % 500 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // 4단계: BufferGeometry 생성
    const mergedGeom = new THREE.BufferGeometry();
    mergedGeom.setAttribute('position', new THREE.BufferAttribute(posOut, 3));
    mergedGeom.setAttribute('normal', new THREE.BufferAttribute(normOut, 3));

    if (useIndex && idxOut) {
      mergedGeom.setIndex(new THREE.BufferAttribute(idxOut, 1));
    }

    return mergedGeom;
  }

  // ───── Material Grouping ─────

  _groupMeshesByMaterial(model) {
    const groups = new Map();

    model.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;

      const material = Array.isArray(child.material) ? child.material[0] : child.material;
      if (!material) return;

      const key = this._getMaterialKey(material);
      if (!groups.has(key)) {
        groups.set(key, { material, meshes: [] });
      }
      groups.get(key).meshes.push(child);
    });

    return groups;
  }

  _getMaterialKey(material) {
    const type = material.type || 'Standard';
    const color = material.color ? material.color.getHexString() : '808080';
    const opacity = (material.opacity ?? 1).toFixed(2);
    const transparent = material.transparent ? 'T' : 'O';
    const side = material.side ?? THREE.FrontSide;
    const metalness = material.metalness !== undefined ? material.metalness.toFixed(2) : '0';
    const roughness = material.roughness !== undefined ? material.roughness.toFixed(2) : '1';
    return `${type}_${color}_${opacity}_${transparent}_${side}_${metalness}_${roughness}`;
  }
}
