/**
 * ModelLoader - GLTF/GLB 모델 로딩 및 관리
 * - 자동 단위 감지 (m/mm)
 * - Z-up 좌표계 감지
 * - 모델 센터링 및 카메라 조정
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class ModelLoader {
  constructor(scene) {
    this.scene = scene;
    this.loader = new GLTFLoader();
    this.model = null;
    this.edgeLines = [];
    this.modelBounds = null;
    this.metricsScale = 1; // mm 단위 기본
    this.metricsUnit = 'mm';
    this.isZUp = false;
  }

  /**
   * URL에서 모델 로드
   * @param {string} url - 모델 파일 URL
   * @param {Function} onProgress - 진행 콜백
   * @returns {Promise<{model: THREE.Group, bounds: THREE.Box3}>}
   */
  loadFromURL(url, onProgress) {
    return new Promise((resolve, reject) => {
      this.loader.load(
        url,
        (gltf) => {
          const result = this._processModel(gltf.scene, url.split('/').pop());
          resolve(result);
        },
        (progress) => {
          if (onProgress && progress.total > 0) {
            const percent = (progress.loaded / progress.total * 100).toFixed(1);
            onProgress(percent);
          }
        },
        (error) => {
          reject(error);
        }
      );
    });
  }

  /**
   * File 객체에서 모델 로드
   * @param {File} file - GLTF/GLB 파일
   * @param {Function} onProgress - 진행 콜백
   * @returns {Promise<{model: THREE.Group, bounds: THREE.Box3}>}
   */
  loadFromFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);

      this.loader.load(
        url,
        (gltf) => {
          URL.revokeObjectURL(url);
          const result = this._processModel(gltf.scene, file.name);
          resolve(result);
        },
        (progress) => {
          if (onProgress && progress.total > 0) {
            const percent = (progress.loaded / progress.total * 100).toFixed(1);
            onProgress(percent);
          }
        },
        (error) => {
          URL.revokeObjectURL(url);
          reject(error);
        }
      );
    });
  }

  /**
   * 모델 후처리 (센터링, 단위 감지, Edge 생성 등)
   */
  _processModel(loadedModel, fileName) {
    // 기존 모델 제거
    this.disposeModel();

    this.model = loadedModel;

    // 바운딩 박스 계산
    const box = new THREE.Box3().setFromObject(this.model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    // 센터링
    this.model.position.set(-center.x, -center.y, -center.z);

    // 센터링 후 바운딩 박스 다시 계산
    this.modelBounds = new THREE.Box3().setFromObject(this.model);

    // 자동 단위 감지
    this._detectUnits(size);

    // Z-up 감지
    this._detectZUp(size);

    // 재질 설정
    this.model.traverse((child) => {
      if (child.isMesh) {
        child.geometry.computeVertexNormals();
        if (child.material) {
          child.material.flatShading = false;
          child.material.side = THREE.DoubleSide;
          child.material.needsUpdate = true;
        }
      }
    });

    // Scene에 추가
    this.scene.add(this.model);

    return {
      model: this.model,
      bounds: this.modelBounds,
      fileName,
      metricsScale: this.metricsScale,
      metricsUnit: this.metricsUnit,
      isZUp: this.isZUp,
    };
  }

  /**
   * 자동 단위 감지 (m/mm)
   * maxSize < 10 → m 단위 (scale = 1000)
   * maxSize >= 10 → mm 단위 (scale = 1)
   */
  _detectUnits(size) {
    const maxSize = Math.max(size.x, size.y, size.z);

    if (maxSize < 10) {
      this.metricsScale = 1000;
      this.metricsUnit = 'mm (from m)';
      console.log('Auto-detect: Model in meters, scale=1000');
    } else {
      this.metricsScale = 1;
      this.metricsUnit = 'mm';
      console.log('Auto-detect: Model in millimeters, scale=1');
    }
  }

  /**
   * Z-up 좌표계 감지
   * Y축 범위가 maxSize의 10% 미만이고 Z축이 Y축의 2배 이상
   */
  _detectZUp(size) {
    const maxSize = Math.max(size.x, size.y, size.z);
    this.isZUp = (size.y < maxSize * 0.1 && size.z > size.y * 2);

    if (this.isZUp) {
      console.log('Auto-detect: Z-up coordinate system detected');
    }
  }

  /**
   * Edge 생성 (Shaded-Wireframe 모드용)
   * @param {number} thresholdAngle - Edge threshold (degrees)
   * @returns {THREE.LineSegments[]}
   */
  createEdges(thresholdAngle = 80) {
    this.clearEdges();

    if (!this.model) return [];

    this.model.traverse((child) => {
      if (child.isMesh && child.geometry) {
        const edgesGeometry = new THREE.EdgesGeometry(child.geometry, thresholdAngle);
        const edgesMaterial = new THREE.LineBasicMaterial({
          color: 0x000000,
          linewidth: 1,
          transparent: true,
          opacity: 0.8,
        });

        const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);

        // world transform 적용
        child.updateWorldMatrix(true, false);
        edges.applyMatrix4(child.matrixWorld);

        this.scene.add(edges);
        this.edgeLines.push(edges);
      }
    });

    return this.edgeLines;
  }

  /** Edge 라인 제거 */
  clearEdges() {
    this.edgeLines.forEach(edge => {
      this.scene.remove(edge);
      edge.geometry.dispose();
      edge.material.dispose();
    });
    this.edgeLines = [];
  }

  /** Edge 표시/숨김 */
  setEdgesVisible(visible) {
    this.edgeLines.forEach(edge => {
      edge.visible = visible;
    });
  }

  /** Edge 라인에 clipping plane 적용 */
  setEdgeClipping(planes) {
    this.edgeLines.forEach(edge => {
      edge.material.clippingPlanes = planes || [];
      edge.material.needsUpdate = true;
    });
  }

  /**
   * 모델의 mesh 목록 반환 (Raycasting용)
   * @returns {THREE.Mesh[]}
   */
  getMeshList() {
    const meshes = [];
    if (this.model) {
      this.model.traverse((child) => {
        if (child.isMesh) meshes.push(child);
      });
    }
    return meshes;
  }

  /** 모델 리소스 정리 */
  disposeModel() {
    if (this.model) {
      this.model.traverse((child) => {
        if (child.isMesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach(m => m.dispose());
          } else if (child.material) {
            child.material.dispose();
          }
        }
      });
      this.scene.remove(this.model);
      this.model = null;
    }
    this.clearEdges();
    this.modelBounds = null;
  }
}
