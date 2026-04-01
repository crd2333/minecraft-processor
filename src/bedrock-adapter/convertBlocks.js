'use strict'

const blocksB2J = require('../../data/generated/blocksB2J.json')
const { stripMinecraftNamespace } = require('../structure_parser')

/**
 * Bedrock Edition → Java Edition block conversion:
 * first block-by-block conversion powered by a pre-generated mapping table.
 * Then a world post-processing step to fix up properties that are missing but can be derived from world context.
 *
 * Runtime prerequisite:
 *   ship data/generated/blocksB2J.json with the release artifacts.
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

// Serialise a Bedrock states object into the same canonical bracket notation used in data/generated/blocksB2J.json.
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

module.exports = { convertBedrockBlock }
