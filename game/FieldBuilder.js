// systems/FieldBuilder.js
import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';

export function buildField(scene, {
    trackLength,
    laneCount,
    startLineX,
    finishLineX,
    laneGap = 6,
}) {

    const makeLine = (x) => {
        const width = 0.3;  
        const length = laneCount * laneGap; 

        const geometry = new THREE.PlaneGeometry(width, length);
        const material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
        const line = new THREE.Mesh(geometry, material);
        const start_offset = 1;
        line.rotation.x = -Math.PI / 2;
        line.position.set(x , 0.4, 0);

        scene.add(line);
        return line;
    };

    const startLine = makeLine(startLineX);
    startLine.position.x += 5;
    const finishLine = makeLine(finishLineX);


    return { startLine, finishLine };
}
