/**
 * LightManager - 조명 설정 관리
 * 3-point lighting + hemisphere light + environment map (IBL)
 */
import * as THREE from 'three';

export class LightManager {
  constructor(scene) {
    this.scene = scene;
    this.lights = {};
    this.envMap = null;
    this._envMapIntensity = 1.0;
    this.setup();
  }

  setup() {
    // Ambient light
    this.lights.ambient = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(this.lights.ambient);

    // Key light (전면 상단)
    this.lights.key = new THREE.DirectionalLight(0xffffff, 0.8);
    this.lights.key.position.set(5, 10, 7);
    this.scene.add(this.lights.key);

    // Fill light (후면 상단)
    this.lights.fill = new THREE.DirectionalLight(0xffffff, 0.3);
    this.lights.fill.position.set(-5, 5, -5);
    this.scene.add(this.lights.fill);

    // Hemisphere light (자연광 효과)
    this.lights.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.3);
    this.scene.add(this.lights.hemi);
  }

  /**
   * PMREMGenerator로 neutral studio 환경맵 생성
   * 금속 재질이 반사할 환경을 제공하여 검게 보이는 문제 해결
   */
  createEnvironmentMap(renderer) {
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();

    // 스튜디오 조명 환경 시뮬레이션 씬
    const envScene = new THREE.Scene();

    // 상단: 밝은 흰색
    const topLight = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })
    );
    topLight.position.set(0, 8, 0);
    topLight.rotation.x = Math.PI / 2;
    envScene.add(topLight);

    // 전면: 약간 밝은 회색
    const frontLight = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 16),
      new THREE.MeshBasicMaterial({ color: 0xcccccc, side: THREE.DoubleSide })
    );
    frontLight.position.set(0, 0, 10);
    envScene.add(frontLight);

    // 후면: 어두운 회색
    const backLight = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 16),
      new THREE.MeshBasicMaterial({ color: 0x666666, side: THREE.DoubleSide })
    );
    backLight.position.set(0, 0, -10);
    envScene.add(backLight);

    // 좌우: 중간 회색
    const sideMatL = new THREE.MeshBasicMaterial({ color: 0x999999, side: THREE.DoubleSide });
    const leftLight = new THREE.Mesh(new THREE.PlaneGeometry(20, 16), sideMatL);
    leftLight.position.set(-10, 0, 0);
    leftLight.rotation.y = Math.PI / 2;
    envScene.add(leftLight);

    const sideMatR = new THREE.MeshBasicMaterial({ color: 0x999999, side: THREE.DoubleSide });
    const rightLight = new THREE.Mesh(new THREE.PlaneGeometry(20, 16), sideMatR);
    rightLight.position.set(10, 0, 0);
    rightLight.rotation.y = -Math.PI / 2;
    envScene.add(rightLight);

    // 하단: 어두운 바닥
    const bottomLight = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20),
      new THREE.MeshBasicMaterial({ color: 0x444444, side: THREE.DoubleSide })
    );
    bottomLight.position.set(0, -8, 0);
    bottomLight.rotation.x = -Math.PI / 2;
    envScene.add(bottomLight);

    this.envMap = pmremGenerator.fromScene(envScene, 0.04).texture;
    this.scene.environment = this.envMap;

    // cleanup
    pmremGenerator.dispose();
    envScene.traverse((child) => {
      if (child.isMesh) {
        child.geometry.dispose();
        child.material.dispose();
      }
    });
  }

  /**
   * 환경맵 활성화/비활성화
   * @param {boolean} enabled
   */
  setEnvMapEnabled(enabled) {
    this.scene.environment = enabled ? this.envMap : null;
  }

  /**
   * 환경맵 강도 설정
   * @param {number} intensity - 0~2 (기본 1.0)
   */
  setEnvMapIntensity(intensity) {
    this._envMapIntensity = intensity;
    // scene.environment 사용 시 각 material의 envMapIntensity로 제어
    this.scene.traverse((child) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(mat => {
          if (mat.envMapIntensity !== undefined) {
            mat.envMapIntensity = intensity;
            mat.needsUpdate = true;
          }
        });
      }
    });
  }

  /** 모델 크기에 따라 조명 위치 조정 */
  adjustForModel(modelSize) {
    const scale = modelSize * 2;
    this.lights.key.position.set(scale, scale * 2, scale * 1.4);
    this.lights.fill.position.set(-scale, scale, -scale);
  }

  /** 감마/밝기 조정은 renderer.toneMapping으로 제어 */
  setIntensity(factor) {
    this.lights.ambient.intensity = 0.5 * factor;
    this.lights.key.intensity = 0.8 * factor;
    this.lights.fill.intensity = 0.3 * factor;
  }

  /**
   * 주변광(Ambient + Hemisphere) 강도 배율 설정
   * @param {number} multiplier - 배율 (0~2, 기본 1.0)
   */
  setAmbientIntensity(multiplier) {
    this.lights.ambient.intensity = 0.5 * multiplier;
    this.lights.hemi.intensity = 0.3 * multiplier;
  }

  /**
   * 직접광(Key + Fill) 강도 배율 설정
   * @param {number} multiplier - 배율 (0~3, 기본 1.0)
   */
  setDirectionalIntensity(multiplier) {
    this.lights.key.intensity = 0.8 * multiplier;
    this.lights.fill.intensity = 0.3 * multiplier;
  }

  dispose() {
    Object.values(this.lights).forEach(light => {
      this.scene.remove(light);
    });
    this.lights = {};
    if (this.envMap) {
      this.envMap.dispose();
      this.envMap = null;
    }
    this.scene.environment = null;
  }
}
