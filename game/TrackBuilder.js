// systems/TrackBuilder.js
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';
import { RoadModel } from './RoadModel.js';

export async function buildRoadBetween(scene, {
  startX,
  endX,
  laneCount,
  segments = 1,
  laneGap = 6,
  baseY = 0,
  extraSegments = 2,
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

  const slotLength = size.x;               // 單段模型長度（因為你 sx=1）
  const targetWidth = laneCount * laneGap; // 跑道總寬

  // 避免修改樣板，先隱藏樣板
  obj.visible = false;
  group.add(obj);

  // 真正鋪設範圍（多加前後 extraSegments）
  const totalSegments = segments + extraSegments * 2;
  const startOffset = -extraSegments; // 從起點前幾段開始

  for (let i = 0; i < totalSegments; i++) {
    const seg = obj.clone(true);
    seg.name = `RoadSeg_${i + 1}`;

    // 縮放（保持原比例，僅調整 Z 符合跑道寬）
    const sx = 1.1;
    const sz = 1.1;
    seg.scale.set(sx, 1, sz);

    // 讓底部貼齊 Y=baseY
    const minY = bbox.min.y;
    seg.position.y = baseY - minY * seg.scale.y;

    // 放置位置：以 slotLength 為基準
    const centerX = startX + (startOffset + i + 0.5) * slotLength;
    seg.position.x = centerX;
    seg.position.z = 1;

    seg.visible = true;
    group.add(seg);
  }

  return group;
}
