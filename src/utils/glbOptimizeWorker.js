/**
 * glbOptimizeWorker.js - Web Worker for GLB optimization
 *
 * 메인 스레드 차단 없이 gltf-transform 파이프라인 실행.
 * postMessage로 로그/진행률을 메인 스레드에 전송.
 */
import { WebIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, flatten, join, prune } from '@gltf-transform/functions';

const io = new WebIO().registerExtensions(ALL_EXTENSIONS);

function log(message, progress) {
  self.postMessage({ type: 'log', message, progress });
}

function analyze(document) {
  const root = document.getRoot();
  const meshes = root.listMeshes();
  let totalPrimitives = 0;
  let totalVertices = 0;
  const materialSet = new Set();

  for (const mesh of meshes) {
    for (const prim of mesh.listPrimitives()) {
      totalPrimitives++;
      const posAttr = prim.getAttribute('POSITION');
      if (posAttr) totalVertices += posAttr.getCount();
      const mat = prim.getMaterial();
      if (mat) materialSet.add(mat);
    }
  }

  return {
    meshes: meshes.length,
    primitives: totalPrimitives,
    vertices: totalVertices,
    materials: materialSet.size,
  };
}

self.onmessage = async (e) => {
  const { arrayBuffer, fileName, fileSize } = e.data;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(1);

  try {
    // 1. Parse
    log(`Reading file... (${sizeMB} MB)`, 0);
    log('Parsing GLB binary...', 0.05);
    const document = await io.readBinary(new Uint8Array(arrayBuffer));

    // 2. Analyze
    log('Analyzing model structure...', 0.15);
    const before = analyze(document);
    log(`  Meshes: ${before.meshes.toLocaleString()}`, 0.15);
    log(`  Primitives (Draw Calls): ${before.primitives.toLocaleString()}`, 0.15);
    log(`  Materials: ${before.materials}`, 0.15);
    log(`  Vertices: ${before.vertices.toLocaleString()}`, 0.2);

    if (before.primitives <= before.materials) {
      log(`Already optimized — primitives (${before.primitives}) <= materials (${before.materials})`, 1.0);
      self.postMessage({
        type: 'done',
        blob: null,
        stats: { before, after: before, skipped: true },
      });
      return;
    }

    // 3. Dedup
    log('Deduplicating materials and accessors...', 0.25);
    await document.transform(
      dedup({ propertyTypes: [PropertyType.MATERIAL, PropertyType.ACCESSOR] }),
    );
    const afterDedup = analyze(document);
    if (afterDedup.materials !== before.materials) {
      log(`  Materials: ${before.materials} → ${afterDedup.materials} (${before.materials - afterDedup.materials} duplicates removed)`, 0.4);
    } else {
      log('  No duplicate materials found', 0.4);
    }

    // 4. Flatten
    log('Flattening scene hierarchy...', 0.5);
    await document.transform(flatten());
    log('  Scene hierarchy flattened', 0.6);

    // 5. Join + Prune
    log('Joining meshes by material...', 0.65);
    await document.transform(
      join({ keepNamed: false }),
      prune(),
    );

    // 6. Result
    const after = analyze(document);
    log(`  Primitives: ${before.primitives.toLocaleString()} → ${after.primitives} (${((1 - after.primitives / before.primitives) * 100).toFixed(1)}% reduction)`, 0.8);

    // 7. Write
    log('Writing optimized GLB...', 0.85);
    const glb = await io.writeBinary(document);
    const newSize = glb.byteLength;
    const newSizeMB = (newSize / 1024 / 1024).toFixed(1);
    const sizeChange = ((newSize / fileSize - 1) * 100).toFixed(1);

    log('--- Optimization Complete ---', 1.0);
    log(`  Draw Calls: ${before.primitives.toLocaleString()} → ${after.primitives}`, 1.0);
    log(`  File Size: ${sizeMB} MB → ${newSizeMB} MB (${sizeChange}%)`, 1.0);
    log(`  Vertices: ${before.vertices.toLocaleString()} → ${after.vertices.toLocaleString()}`, 1.0);

    // ArrayBuffer를 transfer로 전송 (복사 없이)
    self.postMessage({
      type: 'done',
      glbBuffer: glb.buffer,
      fileSize: newSize,
      stats: {
        before,
        after,
        skipped: false,
        reduction: ((1 - after.primitives / before.primitives) * 100).toFixed(1),
        sizeChange,
      },
    }, [glb.buffer]);

  } catch (error) {
    log(`ERROR: ${error.message}`, -1);
    self.postMessage({ type: 'error', message: error.message });
  }
};
