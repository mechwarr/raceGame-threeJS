// RoadModel.js
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.165.0/examples/jsm/loaders/GLTFLoader.js';

export class RoadModel {
  constructor(name = 'RoadModel') {
    this.url = '/public/road/road_nograss_02s.gltf'; // 固定路徑
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

              if (child.material) {
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                materials.forEach(m => {
                  m.side = THREE.DoubleSide;
                  if (m.transparent) {
                    // 改成 alpha clipping 模式
                    m.transparent = false; // 不要啟用混合
                    m.alphaTest = 0.5;     // clip 門檻，0.5 表示 50% 以下直接丟掉
                    m.depthWrite = true;   // 仍然寫入深度
                    m.depthTest = true;
                  }

                });
              }

              // ★ 針對特定 Mesh 名稱設置 renderOrder
              if (child.name.includes("Glass")) {
                child.renderOrder = 1001; // 比較後畫
              } else if (child.name.includes("Decal")) {
                child.renderOrder = 1002; // 最後畫
              } else {
                child.renderOrder = 999;  // 預設
              }
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
  setScale(x, y, z) { if (this.object) this.object.scale.set(x, y, z); }
}
