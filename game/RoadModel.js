// RoadModel.js
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.165.0/examples/jsm/loaders/GLTFLoader.js';

export class RoadModel {
  constructor(name = 'RoadModel') {
    this.url = '/public/road/road_nograss.gltf'; // 固定路徑
    this.name = name;
    this.object = null;
  }

  load() {
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.load(
        this.url,
        (gltf) => {
          this.object = gltf.scene;
          this.object.name = this.name;
          this.object.traverse((child) => {
            if (child.isMesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });
          resolve(this.object);
        },
        undefined,
        (err) => reject(err)
      );
    });
  }

  setPosition(x, y, z) { if (this.object) this.object.position.set(x, y, z); }
  setRotation(x, y, z) { if (this.object) this.object.rotation.set(x, y, z); }
  setScale(x, y, z)    { if (this.object) this.object.scale.set(x, y, z); }
}
