/**
 * GLBOptimizer - Web Worker 기반 GLB 최적화
 *
 * gltf-transform 파이프라인을 별도 스레드에서 실행하여
 * 메인 스레드 차단 없이 UI 갱신 가능.
 */
export class GLBOptimizer {
  /**
   * File 객체에서 GLB 읽기 → Worker에서 최적화 → Blob 반환
   * @param {File} file
   * @param {Function} onLog - (message, progress) 콜백
   * @returns {Promise<{blob: Blob|null, stats: Object}>}
   */
  optimizeFile(file, onLog) {
    return new Promise(async (resolve, reject) => {
      const worker = new Worker(
        new URL('./glbOptimizeWorker.js', import.meta.url),
        { type: 'module' }
      );

      worker.onmessage = (e) => {
        const { type } = e.data;

        if (type === 'log') {
          onLog?.(e.data.message, e.data.progress);
        } else if (type === 'done') {
          worker.terminate();
          if (e.data.stats.skipped) {
            resolve({ blob: null, stats: e.data.stats });
          } else {
            const blob = new Blob(
              [new Uint8Array(e.data.glbBuffer)],
              { type: 'model/gltf-binary' }
            );
            resolve({ blob, stats: e.data.stats });
          }
        } else if (type === 'error') {
          worker.terminate();
          reject(new Error(e.data.message));
        }
      };

      worker.onerror = (err) => {
        worker.terminate();
        reject(new Error(err.message || 'Worker error'));
      };

      // File → ArrayBuffer, transfer로 Worker에 전달
      const arrayBuffer = await file.arrayBuffer();
      worker.postMessage(
        { arrayBuffer, fileName: file.name, fileSize: file.size },
        [arrayBuffer]
      );
    });
  }

  /**
   * Blob을 파일로 다운로드
   */
  downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }
}
