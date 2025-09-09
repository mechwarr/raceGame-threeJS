// systems/TrackBuilder.js
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';
import { RoadModel } from './RoadModel.js';

export async function buildRoadBetween(scene, {
  startX,
  endX,
  laneCount,
  segments = 5,
  laneGap = 6,
  baseY = 0,
  extraSegments = 2,
  uniformSize = 2800,
}) {
  const group = new THREE.Group();
  group.name = 'RoadSegments';
  scene.add(group);

  // 先載入一個 RoadModel 當樣板
  const proto = new RoadModel('RoadProto');
  const obj = await proto.load();

  // 量測原始尺寸
  const bbox = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  bbox.getSize(size); // size.x = 模型長度, size.z = 模型寬度

  // === 等比縮放 ===
  const maxDim = Math.max(size.x, size.z);       // 取長寬中最大的邊
  const scale = uniformSize / maxDim;            // 等比縮放係數

  // 單段模型的實際長度（縮放後）
  const slotLength = size.x * scale;

  // 避免修改樣板，先隱藏樣板
  obj.visible = false;
  group.add(obj);

  // 真正鋪設範圍（多加前後 extraSegments）
  const totalSegments = segments + extraSegments * 2;
  const startOffset = -extraSegments;

  for (let i = 0; i < totalSegments; i++) {
    const seg = obj.clone(true);
    seg.name = `RoadSeg_${i + 1}`;

    // 使用等比縮放
    seg.scale.set(scale, scale, scale);

    // 讓底部貼齊 Y=baseY
    const minY = bbox.min.y;
    seg.position.y = baseY - minY * scale - 2;

    // 放置位置
    const centerX = startX + (startOffset + i + 0.5) * slotLength;
    seg.position.x = centerX;
    seg.position.z = -55;

    seg.visible = true;
    group.add(seg);
  }

  return group;
}
