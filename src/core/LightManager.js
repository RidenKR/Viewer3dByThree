/**
 * LightManager - 조명 설정 관리
 * 3-point lighting + hemisphere light
 */
import * as THREE from 'three';

export class LightManager {
  constructor(scene) {
    this.scene = scene;
    this.lights = {};
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

  dispose() {
    Object.values(this.lights).forEach(light => {
      this.scene.remove(light);
    });
    this.lights = {};
  }
}
