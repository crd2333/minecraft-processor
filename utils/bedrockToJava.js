'use strict'

const blocksB2J = require('../generated/blocksB2J.json')
const { isAirName, stripMinecraftNamespace } = require('./structure')

/**
 * Bedrock Edition → Java Edition block conversion:
 * first block-by-block conversion powered by a pre-generated mapping table.
 * Then a world post-processing step to fix up properties that are missing but can be derived from world context.
 *
 * Runtime prerequisite:
 *   ship generated/blocksB2J.json with the release artifacts.
 */


// #region Conversion utils
// Bedrock-side properties encoded as booleans in the table, typically arrive as 0/1 in parsed .mcstructure data
const BOOL_PROPS = new Set([
  'active',
  'age_bit',
  'attached_bit',
  'big_dripleaf_head',
  'bloom',
  'brewing_stand_slot_a_bit',
  'brewing_stand_slot_b_bit',
  'brewing_stand_slot_c_bit',
  'button_pressed_bit',
  'can_summon',
  'conditional_bit',
  'covered_bit',
  'crafting',
  'dead_bit',
  'disarmed_bit',
  'door_hinge_bit',
  'drag_down',
  'end_portal_eye_bit',
  'explode_bit',
  'extinguished',
  'hanging',
  'head_piece_bit',
  'in_wall_bit',
  'infiniburn_bit',
  'lit',
  'natural',
  'occupied_bit',
  'ominous',
  'open_bit',
  'output_lit_bit',
  'output_subtract_bit',
  'persistent_bit',
  'powered_bit',
  'rail_data_bit',
  'stability_check',
  'suspended_bit',
  'tip',
  'toggle_bit',
  'triggered_bit',
  'update_bit',
  'upper_block_bit',
  'upside_down_bit',
  'wall_post_bit'
])

// Serialise a Bedrock states object into the same canonical bracket notation used in generated/blocksB2J.json.
function serializeBedrockKey (name, states) {
  const fullName = name.includes(':') ? name : 'minecraft:' + name
  const keys = Object.keys(states).sort()
  if (keys.length === 0) return fullName + '[]'

  const inner = keys.map(key => {
    const value = states[key]
    if (BOOL_PROPS.has(key)) {
      return key + '=' + ((value === 1 || value === true || value === '1' || value === 'true') ? 'true' : 'false')
    }
    return key + '=' + value
  }).join(',')

  return fullName + '[' + inner + ']'
}

// Parse the Java-side block string from the mapping table, which is in the format "minecraft:block_name[prop=value,...]".
function parseJavaStr (jStr) {
  const bracket = jStr.indexOf('[')
  if (bracket === -1) return { name: jStr, properties: {} }

  const name = jStr.slice(0, bracket)
  const inner = jStr.slice(bracket + 1, jStr.length - 1)
  const properties = {}

  if (inner) {
    for (const part of inner.split(',')) {
      const eq = part.indexOf('=')
      properties[part.slice(0, eq)] = part.slice(eq + 1)
    }
  }

  return { name, properties }
}
// #endregion Conversion utils


// #region Post-process utils
const HORIZONTAL_OFFSETS = {
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  west: { x: -1, y: 0, z: 0 },
  east: { x: 1, y: 0, z: 0 }
}

const MUSHROOM_VERTICAL_OFFSETS = {
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 }
}

// ## Position and facing helpers

function offsetPos (Vec3, pos, dir) {
  const delta = HORIZONTAL_OFFSETS[dir]
  if (!delta) return new Vec3(pos.x, pos.y, pos.z)
  return new Vec3(pos.x + delta.x, pos.y + delta.y, pos.z + delta.z)
}

function offsetXYZ (Vec3, pos, x, y, z) {
  return new Vec3(pos.x + x, pos.y + y, pos.z + z)
}

function facingAxis (facing) {
  return facing === 'east' || facing === 'west' ? 'x' : facing === 'north' || facing === 'south' ? 'z' : null
}

function oppositeFacing (facing) {
  if (facing === 'north') return 'south'
  if (facing === 'south') return 'north'
  if (facing === 'west') return 'east'
  if (facing === 'east') return 'west'
  return null
}

function rotateFacingLeft (facing) {
  if (facing === 'north') return 'west'
  if (facing === 'west') return 'south'
  if (facing === 'south') return 'east'
  if (facing === 'east') return 'north'
  return null
}

function rotateFacingRight (facing) {
  if (facing === 'north') return 'east'
  if (facing === 'east') return 'south'
  if (facing === 'south') return 'west'
  if (facing === 'west') return 'north'
  return null
}

function posKey (pos) {
  return pos.x + ',' + pos.y + ',' + pos.z
}

function uniquePositions (Vec3, positions) {
  const seen = new Set()
  const out = []
  for (const pos of positions || []) {
    const key = posKey(pos)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(new Vec3(pos.x, pos.y, pos.z))
  }
  return out
}

// ## Block property accessors and predicates

function getBlockProperties (block) {
  return typeof block?.getProperties === 'function' ? { ...block.getProperties() } : {}
}

function isTruthyProp (value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function isAirBlock (block) {
  return !block || isAirName(block.name) || block.boundingBox === 'empty'
}

function isFullBlock (block) {
  return !isAirBlock(block) && block.boundingBox === 'block'
}

function isStairBlock (block) {
  return Boolean(block?.name && block.name.endsWith('_stairs'))
}

function isChestBlock (block) {
  return block?.name === 'chest' || block?.name === 'trapped_chest'
}

function isMatchingChest (block, other) {
  if (!isChestBlock(block) || !isChestBlock(other)) return false
  const props = getBlockProperties(block)
  const otherProps = getBlockProperties(other)
  return block.name === other.name && props.facing === otherProps.facing
}

function isVineBlock (block) {
  return block?.name === 'vine'
}

function isFenceBlock (block) {
  return Boolean(block?.name && block.name.endsWith('_fence'))
}

function isFenceGateBlock (block) {
  return Boolean(block?.name && block.name.endsWith('_fence_gate'))
}

function isPaneBlock (block) {
  return Boolean(block?.name && block.name.endsWith('_pane'))
}

function isIronBarsBlock (block) {
  return block?.name === 'iron_bars'
}

function isTripwireBlock (block) {
  return block?.name === 'tripwire'
}

function isTripwireHookBlock (block) {
  return block?.name === 'tripwire_hook'
}

function isRedstoneWireBlock (block) {
  return block?.name === 'redstone_wire'
}

function isChorusPlantBlock (block) {
  return block?.name === 'chorus_plant' || block?.name === 'chorus_flower'
}

function isMushroomSurfaceBlock (block) {
  return block?.name === 'brown_mushroom_block' || block?.name === 'red_mushroom_block' || block?.name === 'mushroom_stem'
}

function isRepeaterLikeBlock (block) {
  return block?.name === 'repeater' || block?.name === 'comparator'
}

// ## Connection rules and support checks

function supportsRedstoneUp (block) {
  return isFullBlock(block) || isRepeaterLikeBlock(block) || isRedstoneWireBlock(block)
}

function redstoneAcceptsConnection (block, direction) {
  if (isAirBlock(block)) return false
  if (isRedstoneWireBlock(block)) return true
  if (block?.name === 'redstone_torch' || block?.name === 'redstone_wall_torch') return true
  if (block?.name === 'lever') return true
  if (block?.name && block.name.endsWith('_button')) return true
  if (isRepeaterLikeBlock(block)) {
    const props = getBlockProperties(block)
    return props.facing === direction || props.facing === oppositeFacing(direction)
  }
  if (block?.name === 'observer') {
    const props = getBlockProperties(block)
    return props.facing === direction
  }
  return false
}

async function setBlockProperties (world, Block, pos, name, properties) {
  const block = Block.fromProperties(name, properties, 0)
  await world.setBlock(pos, block)
}

async function isDifferentStairOrientation (world, Vec3, pos, block, direction) {
  const neighbour = await world.getBlock(offsetPos(Vec3, pos, direction))
  if (!isStairBlock(neighbour)) return true

  const props = getBlockProperties(block)
  const neighbourProps = getBlockProperties(neighbour)
  return neighbourProps.facing !== props.facing || neighbourProps.half !== props.half
}


function canFenceConnectTo (source, target) {
  if (isAirBlock(target)) return false
  if (isFenceBlock(target) || isFenceGateBlock(target)) return true
  if (isFullBlock(target)) return true
  return false
}

function canPaneConnectTo (source, target) {
  if (isAirBlock(target)) return false
  if (isPaneBlock(target) || isIronBarsBlock(target)) return true
  if (isFullBlock(target)) return true
  return false
}

function canTripwireConnectTo (target) {
  return isTripwireBlock(target) || isTripwireHookBlock(target)
}

// ## Context-derived property resolvers

async function deriveStairShape (world, Vec3, pos, stair) {
  const props = getBlockProperties(stair)
  const facing = props.facing
  const half = props.half
  if (!HORIZONTAL_OFFSETS[facing] || !half) return null

  const front = await world.getBlock(offsetPos(Vec3, pos, facing))
  if (isStairBlock(front)) {
    const frontProps = getBlockProperties(front)
    if (frontProps.half === half && facingAxis(frontProps.facing) !== facingAxis(facing)) {
      const shouldJoin = await isDifferentStairOrientation(world, Vec3, pos, stair, oppositeFacing(frontProps.facing))
      if (shouldJoin) {
        return frontProps.facing === rotateFacingLeft(facing) ? 'outer_left' : 'outer_right'
      }
    }
  }

  const back = await world.getBlock(offsetPos(Vec3, pos, oppositeFacing(facing)))
  if (isStairBlock(back)) {
    const backProps = getBlockProperties(back)
    if (backProps.half === half && facingAxis(backProps.facing) !== facingAxis(facing)) {
      const shouldJoin = await isDifferentStairOrientation(world, Vec3, pos, stair, backProps.facing)
      if (shouldJoin) {
        return backProps.facing === rotateFacingLeft(facing) ? 'inner_left' : 'inner_right'
      }
    }
  }

  return 'straight'
}

async function deriveChestType (world, Vec3, pos, chest) {
  const props = getBlockProperties(chest)
  const facing = props.facing
  if (!HORIZONTAL_OFFSETS[facing]) return null

  const leftSidePos = offsetPos(Vec3, pos, rotateFacingRight(facing))
  const rightSidePos = offsetPos(Vec3, pos, rotateFacingLeft(facing))
  const leftSide = await world.getBlock(leftSidePos)
  if (isMatchingChest(chest, leftSide)) return 'left'

  const rightSide = await world.getBlock(rightSidePos)
  if (isMatchingChest(chest, rightSide)) return 'right'

  return 'single'
}

function canSupportVineTop (block) {
  if (!block || block.name === 'air' || block.boundingBox === 'empty') return false
  if (isVineBlock(block)) return true
  return block.boundingBox === 'block'
}
// #endregion Post-process utils


// #region Post-processing passes
async function stairsShapePass (context) {
  let changed = 0

  for (const pos of context.positions) {
    const block = await context.world.getBlock(pos)
    if (!isStairBlock(block)) continue

    const props = getBlockProperties(block)
    const nextShape = await deriveStairShape(context.world, context.Vec3, pos, block)
    if (!nextShape || props.shape === nextShape) continue

    await setBlockProperties(context.world, context.Block, pos, block.name, { ...props, shape: nextShape })
    changed++
  }

  return changed
}

async function chestTypePass (context) {
  let changed = 0

  for (const pos of context.positions) {
    const block = await context.world.getBlock(pos)
    if (!isChestBlock(block)) continue

    const props = getBlockProperties(block)
    const nextType = await deriveChestType(context.world, context.Vec3, pos, block)
    if (!nextType || props.type === nextType) continue

    await setBlockProperties(context.world, context.Block, pos, block.name, { ...props, type: nextType })
    changed++
  }

  return changed
}

async function vineUpPass (context) {
  let changed = 0

  for (const pos of context.positions) {
    const block = await context.world.getBlock(pos)
    if (!isVineBlock(block)) continue

    const props = getBlockProperties(block)
    const above = await context.world.getBlock(offsetXYZ(context.Vec3, pos, 0, 1, 0))
    const nextUp = canSupportVineTop(above)
    if (isTruthyProp(props.up) === nextUp) continue

    await setBlockProperties(context.world, context.Block, pos, block.name, { ...props, up: nextUp })
    changed++
  }

  return changed
}

async function horizontalConnectionsPass (context) {
  let changed = 0

  for (const pos of context.positions) {
    const block = await context.world.getBlock(pos)
    const props = getBlockProperties(block)
    let deriveConnection = null

    if (isFenceBlock(block)) deriveConnection = neighbour => canFenceConnectTo(block, neighbour)
    else if (isPaneBlock(block) || isIronBarsBlock(block)) deriveConnection = neighbour => canPaneConnectTo(block, neighbour)
    else if (isTripwireBlock(block)) deriveConnection = canTripwireConnectTo
    else continue

    const nextProps = { ...props }
    let dirty = false

    for (const dir of Object.keys(HORIZONTAL_OFFSETS)) {
      const neighbour = await context.world.getBlock(offsetPos(context.Vec3, pos, dir))
      const nextValue = deriveConnection(neighbour)
      if (isTruthyProp(props[dir]) === nextValue) continue
      nextProps[dir] = nextValue
      dirty = true
    }

    if (!dirty) continue
    await setBlockProperties(context.world, context.Block, pos, block.name, nextProps)
    changed++
  }

  return changed
}

async function redstoneWirePass (context) {
  let changed = 0

  for (const pos of context.positions) {
    const block = await context.world.getBlock(pos)
    if (!isRedstoneWireBlock(block)) continue

    const props = getBlockProperties(block)
    const nextProps = { ...props }
    let dirty = false

    for (const dir of Object.keys(HORIZONTAL_OFFSETS)) {
      const sidePos = offsetPos(context.Vec3, pos, dir)
      const side = await context.world.getBlock(sidePos)
      let nextValue = 'none'

      if (redstoneAcceptsConnection(side, dir)) {
        nextValue = 'side'
      } else if (isFullBlock(side)) {
        const aboveSide = await context.world.getBlock(offsetXYZ(context.Vec3, sidePos, 0, 1, 0))
        if (redstoneAcceptsConnection(aboveSide, dir) && !isFullBlock(await context.world.getBlock(offsetXYZ(context.Vec3, pos, 0, 1, 0)))) {
          nextValue = 'up'
        }
      } else {
        const belowSide = await context.world.getBlock(offsetXYZ(context.Vec3, sidePos, 0, -1, 0))
        if (redstoneAcceptsConnection(belowSide, dir) && supportsRedstoneUp(belowSide)) {
          nextValue = 'side'
        }
      }

      if (props[dir] === nextValue) continue
      nextProps[dir] = nextValue
      dirty = true
    }

    if (!dirty) continue
    await setBlockProperties(context.world, context.Block, pos, block.name, nextProps)
    changed++
  }

  return changed
}

async function chorusPlantPass (context) {
  let changed = 0

  for (const pos of context.positions) {
    const block = await context.world.getBlock(pos)
    if (block?.name !== 'chorus_plant') continue

    const props = getBlockProperties(block)
    const nextProps = { ...props }
    let dirty = false

    for (const dir of Object.keys(HORIZONTAL_OFFSETS)) {
      const neighbour = await context.world.getBlock(offsetPos(context.Vec3, pos, dir))
      const nextValue = isChorusPlantBlock(neighbour)
      if (isTruthyProp(props[dir]) === nextValue) continue
      nextProps[dir] = nextValue
      dirty = true
    }

    const above = await context.world.getBlock(offsetXYZ(context.Vec3, pos, 0, 1, 0))
    const below = await context.world.getBlock(offsetXYZ(context.Vec3, pos, 0, -1, 0))
    const nextUp = isChorusPlantBlock(above)
    const nextDown = isChorusPlantBlock(below) || below?.name === 'end_stone'

    if (isTruthyProp(props.up) !== nextUp) {
      nextProps.up = nextUp
      dirty = true
    }
    if (isTruthyProp(props.down) !== nextDown) {
      nextProps.down = nextDown
      dirty = true
    }

    if (!dirty) continue
    await setBlockProperties(context.world, context.Block, pos, block.name, nextProps)
    changed++
  }

  return changed
}

async function mushroomBlockPass (context) {
  let changed = 0

  for (const pos of context.positions) {
    const block = await context.world.getBlock(pos)
    if (block?.name !== 'brown_mushroom_block' && block?.name !== 'red_mushroom_block') continue

    const props = getBlockProperties(block)
    const nextProps = { ...props }
    let dirty = false

    for (const dir of Object.keys(HORIZONTAL_OFFSETS)) {
      const neighbour = await context.world.getBlock(offsetPos(context.Vec3, pos, dir))
      const nextValue = !isMushroomSurfaceBlock(neighbour)
      if (isTruthyProp(props[dir]) === nextValue) continue
      nextProps[dir] = nextValue
      dirty = true
    }

    for (const [dir, delta] of Object.entries(MUSHROOM_VERTICAL_OFFSETS)) {
      const neighbour = await context.world.getBlock(offsetXYZ(context.Vec3, pos, delta.x, delta.y, delta.z))
      const nextValue = !isMushroomSurfaceBlock(neighbour)
      if (isTruthyProp(props[dir]) === nextValue) continue
      nextProps[dir] = nextValue
      dirty = true
    }

    if (!dirty) continue
    await setBlockProperties(context.world, context.Block, pos, block.name, nextProps)
    changed++
  }

  return changed
}
// #endregion Post-processing passes

const POST_PROCESS_PASSES = [
  { name: 'stairsShape', run: stairsShapePass },
  { name: 'chestType', run: chestTypePass },
  { name: 'horizontalConnections', run: horizontalConnectionsPass },
  { name: 'redstoneWire', run: redstoneWirePass },
  { name: 'chorusPlant', run: chorusPlantPass },
  { name: 'mushroomBlock', run: mushroomBlockPass },
  { name: 'vineUp', run: vineUpPass }
]


// #region Public API
/**
 * Convert a Bedrock block (name + states from a .mcstructure palette entry)
 * into the { name, properties } shape expected by
 * prismarine-block's Block.fromProperties().
 *
 * @param {string} rawName   Block name from Bedrock palette, with or without
 *                           "minecraft:" namespace prefix.
 * @param {Record<string, string|number|boolean>} states
 *                           Bedrock block states as parsed by prismarine-nbt.
 * @returns {{ name: string, properties: Record<string, string> }}
 */
function convertBedrockBlock (rawName, states) {
  const key = serializeBedrockKey(rawName, states)
  const jStr = blocksB2J[key]
  if (jStr) {
    const { name, properties } = parseJavaStr(jStr)
    const shortName = stripMinecraftNamespace(name)
    return { name: shortName, properties }
  }

  const shortName = stripMinecraftNamespace(rawName)
  return { name: shortName, properties: {} }
}

/**
 * Post-process a converted Java world to fix up block properties that couldn't be derived
 * during block-by-block conversion but can be inferred from world context.
 *
 * @param {object} options
 * @param {import('prismarine-world').World} options.world
 * @param {import('prismarine-block').Block} options.Block
 * @param {import('vec3').Vec3} options.Vec3
 * @param {Array<import('vec3').Vec3>} options.positions
 *   The positions to consider for post-processing. For best results, this should include all non-air blocks in the world.
 * @param {object} [options.logger=console]
 *   Optional logger with a .log() method to report which passes made changes.
 * @returns {Promise<{ totalChanged: number, passes: Array<{ name: string, changed: number }> }>}
 */
async function postProcessWorld ({ world, Block, Vec3, positions, logger = console }) {
  const context = {
    world,
    Block,
    Vec3,
    positions: uniquePositions(Vec3, positions)
  }

  const summary = {
    totalChanged: 0,
    passes: []
  }

  for (const pass of POST_PROCESS_PASSES) {
    const changed = await pass.run(context)
    summary.passes.push({ name: pass.name, changed })
    summary.totalChanged += changed
  }

  if (summary.totalChanged > 0 && logger?.log) {
    logger.log('Applied Java world post-process:', summary.passes.map(pass => pass.name + '=' + pass.changed).join(', '))
  }

  return summary
}
// #endregion Public API

module.exports = { convertBedrockBlock, postProcessWorld }
