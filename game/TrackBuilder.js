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
  uniformSize = 2000,

  // ★ 新增：賽道分隔白線參數
  addLaneLines = true,
  lineThickness = 0.3,     // 線的寬度（沿 Z）
  lineLength = 100000,     // 線的長度（沿 X），很長 ≈ 無限
  lineColor = 0xffffff,    // 線色
  lineYOffset = 0.02,      // 從路面再抬一點，避免 z-fighting
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

  // 路面貼齊 Y 的基準（樣本 bounding box 的最低點）
  const minY = bbox.min.y;
  const roadTopY = baseY - minY * scale - 9; // 你的原始 code 有 -9 偏移；保留

  for (let i = 0; i < totalSegments; i++) {
    const seg = obj.clone(true);
    seg.name = `RoadSeg_${i + 1}`;

    // 使用等比縮放
    seg.scale.set(scale, scale, scale);

    // 讓底部貼齊 roadTopY
    seg.position.y = roadTopY;

    // 放置位置
    const centerX = startX + (startOffset + i + 0.5) * slotLength;
    seg.position.x = centerX;

    // 你的路在 Z = -170；保留
    const centerZ = -170;
    seg.position.z = centerZ;

    seg.visible = true;
    group.add(seg);
  }

  // ====== ★ 在每個賽道之間建立白線（沿 X 幾乎無限長） ======
  if (addLaneLines && laneCount > 1) {
    const linesGroup = new THREE.Group();
    linesGroup.name = 'LaneLines';
    group.add(linesGroup);

    // 取得路面「頂面」的世界 y：bottom + height
    const roadBottomY = baseY - 9;                          // 由你的擺放公式推導：每段底部 = baseY - 9
    const roadHeight  = (bbox.max.y - bbox.min.y) * scale;  // 模型高度（縮放後）
    const roadTopY    = roadBottomY + roadHeight;           // 頂面 y
    const lineY       = roadTopY + lineYOffset;             // 再抬一點避免 z-fighting

    // 以第一段的 z 當中心（不再硬寫 -170）
    const firstSeg = group.children.find(n => n.name?.startsWith?.('RoadSeg_'));
    const centerZ  = firstSeg ? firstSeg.position.z : 0;

    // 材質：貼地又不閃
    const mat = new THREE.MeshBasicMaterial({
      color: lineColor,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      depthWrite: true,
      depthTest: true,
    });

    // 幾何：沿 X 很長、沿 Z 很薄
    const geo = new THREE.PlaneGeometry(lineLength, lineThickness);

    // 分隔線位置：k=1..(laneCount-1)
    // Zk = centerZ + (k - laneCount/2) * laneGap
    const mid = laneCount / 2;
    const midX = (startX + endX) * 0.5;

    for (let k = 1; k <= laneCount - 1; k++) {
      const zPos = centerZ + (k - mid) * laneGap;
      const line = new THREE.Mesh(geo, mat);
      line.name = `LaneLine_${k}`;
      line.rotation.x = -Math.PI / 2; // 躺平到 XZ
      line.position.set(midX, lineY, zPos);
      line.renderOrder = 10;
      linesGroup.add(line);
    }

    // 小技巧：若仍不顯眼，臨時加粗＆加高看看視覺確認
    // mat.color.set(0xffff00); // 測試用亮黃色
    // geo.parameters.width = 200000; // 或直接調 lineLength
  }

  return group;
}
