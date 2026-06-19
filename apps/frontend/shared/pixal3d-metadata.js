function vec3ToArray (value, fallback) {
  if (Array.isArray(value)) {
    const out = value.slice(0, 3).map(Number)
    return out.every(Number.isFinite) ? out : fallback.slice()
  }
  const source = value || {}
  const out = [Number(source.x), Number(source.y), Number(source.z)]
  return out.every(Number.isFinite) ? out : fallback.slice()
}

function dot3 (a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function applyRows3 (rows, point) {
  return [
    dot3(rows[0].slice(0, 3), point) + rows[0][3],
    dot3(rows[1].slice(0, 3), point) + rows[1][3],
    dot3(rows[2].slice(0, 3), point) + rows[2][3]
  ]
}

function pixal3DDistanceFromFov (cameraAngleX, meshScale) {
  return 0.5 / Math.max(meshScale, 1e-6) / Math.max(Math.tan(cameraAngleX / 2), 1e-6)
}

function minecraftVectorToProjGridWorld (vector) {
  return [vector[0], -vector[2], vector[1]]
}

function cameraToProjGridWorldMatrix (right, up, towardCamera, cameraPosition, pivotWorld, extent, meshScale) {
  const scale = Math.max(extent * meshScale, 1e-6)
  const projRight = minecraftVectorToProjGridWorld(right)
  const projUp = minecraftVectorToProjGridWorld(up)
  const projTowardCamera = minecraftVectorToProjGridWorld(towardCamera)
  const projPosition = minecraftVectorToProjGridWorld([
    (cameraPosition[0] - pivotWorld[0]) / scale,
    (cameraPosition[1] - pivotWorld[1]) / scale,
    (cameraPosition[2] - pivotWorld[2]) / scale
  ])

  return [
    [projRight[0], projUp[0], projTowardCamera[0], projPosition[0]],
    [projRight[1], projUp[1], projTowardCamera[1], projPosition[1]],
    [projRight[2], projUp[2], projTowardCamera[2], projPosition[2]],
    [0, 0, 0, 1]
  ]
}

function sourceBlockIndexToProjGridUnitRows (originWorld, pivotWorld, extent) {
  const scale = Math.max(extent, 1e-6)
  return [
    [1 / scale, 0, 0, (originWorld[0] + 0.5 - pivotWorld[0]) / scale],
    [0, 0, -1 / scale, -(originWorld[2] + 0.5 - pivotWorld[2]) / scale],
    [0, 1 / scale, 0, (originWorld[1] + 0.5 - pivotWorld[1]) / scale],
    [0, 0, 0, 1]
  ]
}

function buildCameraMetadata (camera, width, height) {
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  return {
    fov: camera.fov,
    aspect: width / Math.max(height, 1),
    near: camera.near,
    far: camera.far,
    position: camera.position.toArray(),
    rotation: [
      camera.rotation.x,
      camera.rotation.y,
      camera.rotation.z
    ],
    quaternion: camera.quaternion.toArray(),
    matrixWorld: Array.from(camera.matrixWorld.elements),
    projectionMatrix: Array.from(camera.projectionMatrix.elements)
  }
}

function buildPixal3DMetadata (THREE, camera, exportContext, width, height, options) {
  const opts = options || {}
  const sourceContext = (exportContext && exportContext.source) || {}
  const originWorld = vec3ToArray(sourceContext.originWorld, [0, 60, 0])
  const size = vec3ToArray(sourceContext.size, [1, 1, 1]).map(v => Math.max(1, v))
  const pivotWorld = vec3ToArray(sourceContext.pivotWorld, [
    originWorld[0] + size[0] / 2,
    originWorld[1] + size[1] / 2,
    originWorld[2] + size[2] / 2
  ])
  const meshScale = Math.max(Number(opts.meshScale) || 1, 1e-6)

  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  const e = camera.matrixWorld.elements
  const right = [e[0], e[1], e[2]]
  const up = [e[4], e[5], e[6]]
  const towardCamera = [e[8], e[9], e[10]]
  const cameraPosition = [e[12], e[13], e[14]]

  const blockCenterOffsetWorld = [
    originWorld[0] + 0.5,
    originWorld[1] + 0.5,
    originWorld[2] + 0.5
  ]
  const canonicalRows = [right, up, towardCamera].map(axis => [
    axis[0],
    axis[1],
    axis[2],
    dot3(axis, blockCenterOffsetWorld) - dot3(axis, pivotWorld)
  ])
  canonicalRows.push([0, 0, 0, 1])

  const volumeRows = [right, up, towardCamera].map(axis => [
    axis[0],
    axis[1],
    axis[2],
    dot3(axis, originWorld) - dot3(axis, pivotWorld)
  ])
  const canonicalCorners = []
  for (const x of [0, size[0]]) {
    for (const y of [0, size[1]]) {
      for (const z of [0, size[2]]) {
        canonicalCorners.push(applyRows3(volumeRows, [x, y, z]))
      }
    }
  }
  const mins = [0, 1, 2].map(axis => Math.min(...canonicalCorners.map(p => p[axis])))
  const maxs = [0, 1, 2].map(axis => Math.max(...canonicalCorners.map(p => p[axis])))
  const normalizationExtent = Math.max(1, ...maxs.map((v, i) => v - mins[i]))
  const unitRows = canonicalRows.map((row, index) => {
    if (index === 3) return row.slice()
    return row.map(value => value / normalizationExtent)
  })
  const unrotatedNormalizationExtent = Math.max(1, ...size)

  const fovY = THREE.MathUtils.degToRad(camera.fov)
  const aspect = width / Math.max(height, 1)
  const cameraAngleX = 2 * Math.atan(Math.tan(fovY / 2) * aspect)
  const cameraDistance = pixal3DDistanceFromFov(cameraAngleX, meshScale)

  return {
    format: 'minecraft-pixal3d-transform',
    asset: exportContext ? exportContext.asset : null,
    source: {
      coordinate_space: sourceContext.coordinateSpace || 'minecraft_unified_blocks',
      block_point: sourceContext.blockPoint || 'center',
      origin_world: originWorld,
      size,
      pivot_world: pivotWorld
    },
    modes: {
      rotate_voxels_frontview: {
        voxel_transform: {
          source_block_index_to_pixal_unit: unitRows,
          normalization_extent: normalizationExtent
        },
        camera: {
          camera_angle_x: cameraAngleX,
          distance: cameraDistance,
          mesh_scale: meshScale
        }
      },
      rotate_camera_unrotated_voxels: {
        voxel_transform: {
          source_block_index_to_projgrid_unit: sourceBlockIndexToProjGridUnitRows(
            originWorld,
            pivotWorld,
            unrotatedNormalizationExtent
          ),
          normalization_extent: unrotatedNormalizationExtent
        },
        camera: {
          camera_angle_x: cameraAngleX,
          camera_to_projgrid_world: cameraToProjGridWorldMatrix(
            right,
            up,
            towardCamera,
            cameraPosition,
            pivotWorld,
            unrotatedNormalizationExtent,
            meshScale
          ),
          mesh_scale: meshScale
        }
      }
    }
  }
}

module.exports = {
  buildCameraMetadata,
  buildPixal3DMetadata
}
