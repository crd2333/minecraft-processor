'use strict'

const minecraftDataRaw = require('minecraft-data/data.js')

function stripMinecraftNamespace (name) {
  if (!name) return ''
  return name.startsWith('minecraft:') ? name.slice('minecraft:'.length) : name
}

/**
 * Bedrock Edition → Java Edition block conversion:
 * first block-by-block conversion powered by upstream versioned minecraft-data mappings.
 * Then a world post-processing step to fix up properties that are missing but can be derived from world context.
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

function normalizeBoolValue (value) {
  return value === 1 || value === true || value === '1' || value === 'true'
}

function formatBedrockStateValue (key, value, boolStyle) {
  if (BOOL_PROPS.has(key)) {
    const normalized = normalizeBoolValue(value)
    if (boolStyle === 'numeric') return normalized ? '1' : '0'
    return normalized ? 'true' : 'false'
  }

  return String(value)
}

// Serialise a Bedrock states object into candidate key formats used by minecraft-data bedrock mappings.
function serializeBedrockKeys (name, states) {
  const fullName = name.includes(':') ? name : 'minecraft:' + name
  const keys = Object.keys(states).sort()
  if (keys.length === 0) return [fullName + '[]']

  const makeKey = (boolStyle) => {
    const inner = keys.map(key => key + '=' + formatBedrockStateValue(key, states[key], boolStyle)).join(',')
    return fullName + '[' + inner + ']'
  }

  const booleanKey = makeKey('boolean')
  const numericKey = makeKey('numeric')
  return booleanKey === numericKey ? [booleanKey] : [booleanKey, numericKey]
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

const upstreamMappingCache = new Map()

function decodeBedrockVersionNumber (sourceVersion) {
  if (!Number.isInteger(sourceVersion) || sourceVersion <= 0) return null

  return [
    (sourceVersion >>> 24) & 0xFF,
    (sourceVersion >>> 16) & 0xFF,
    (sourceVersion >>> 8) & 0xFF,
    sourceVersion & 0xFF
  ]
}

function listCandidateVersionKeys (sourceVersion) {
  if (sourceVersion === null || sourceVersion === undefined || sourceVersion === '') return []

  const candidates = []
  const seen = new Set()
  const add = (value) => {
    if (!value) return
    const normalized = String(value).trim()
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    candidates.push(normalized)
  }

  if (typeof sourceVersion === 'number') {
    add(String(sourceVersion))
    const decoded = decodeBedrockVersionNumber(sourceVersion)
    if (decoded) {
      add(decoded.join('.'))
      add(decoded.slice(0, 3).join('.'))
    }
  } else if (typeof sourceVersion === 'string') {
    add(sourceVersion)

    const numeric = Number(sourceVersion)
    if (Number.isInteger(numeric) && numeric > 0) {
      const decoded = decodeBedrockVersionNumber(numeric)
      if (decoded) {
        add(decoded.join('.'))
        add(decoded.slice(0, 3).join('.'))
      }
    }

    const segments = sourceVersion.split('.').map(part => part.trim()).filter(Boolean)
    if (segments.length >= 4) add(segments.slice(0, 3).join('.'))
  }

  return candidates
}

function selectFallbackVersionKey (candidates) {
  const availableVersions = Object.keys(minecraftDataRaw?.bedrock || {})
  for (const candidate of candidates) {
    const parts = candidate.split('.').map(part => Number(part))
    if (parts.some(Number.isNaN)) continue

    if (parts.length >= 3) {
      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`
      if (minecraftDataRaw?.bedrock?.[prefix]) return prefix
    }

    if (parts.length >= 2) {
      const prefix = `${parts[0]}.${parts[1]}.`
      const familyMatches = availableVersions
        .filter(version => version.startsWith(prefix))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      if (familyMatches.length > 0) return familyMatches[familyMatches.length - 1]
    }
  }

  return null
}

function normalizeBedrockVersionKey (sourceVersion) {
  const candidates = listCandidateVersionKeys(sourceVersion)
  for (const candidate of candidates) {
    if (minecraftDataRaw?.bedrock?.[candidate]) return candidate
  }

  return selectFallbackVersionKey(candidates)
}

function getUpstreamBedrockMapping (sourceVersion) {
  const normalizedVersion = normalizeBedrockVersionKey(sourceVersion)
  if (!normalizedVersion) return null
  if (upstreamMappingCache.has(normalizedVersion)) return upstreamMappingCache.get(normalizedVersion)

  const mapping = minecraftDataRaw?.bedrock?.[normalizedVersion]?.blocksB2J || null
  upstreamMappingCache.set(normalizedVersion, mapping)
  return mapping
}

function getBedrockToJavaMapping (sourceVersion) {
  const upstream = getUpstreamBedrockMapping(sourceVersion)
  return {
    mapping: upstream || {},
    source: upstream ? `minecraft-data bedrock ${normalizeBedrockVersionKey(sourceVersion)}` : null
  }
}

/**
 * Convert a Bedrock block (name + states from a .mcstructure palette entry)
 * into the { name, properties } shape expected by
 * prismarine-block's Block.fromProperties().
 *
 * @param {string} rawName   Block name from Bedrock palette, with or without
 *                           "minecraft:" namespace prefix.
 * @param {Record<string, string|number|boolean>} states
 *                           Bedrock block states as parsed by prismarine-nbt.
 * @param {{ sourceVersion?: string|null }} [options]
 * @returns {{ name: string, properties: Record<string, string>, matched: boolean, mappingSource: string|null, sourceKey: string }}
 */
function convertBedrockBlock (rawName, states, options = {}) {
  const sourceKeys = serializeBedrockKeys(rawName, states)
  const { mapping, source } = getBedrockToJavaMapping(options.sourceVersion)
  for (const key of sourceKeys) {
    const jStr = mapping[key]
    if (jStr) {
      const { name, properties } = parseJavaStr(jStr)
      const shortName = stripMinecraftNamespace(name)
      return {
        name: shortName,
        properties,
        matched: true,
        mappingSource: source,
        sourceKey: key
      }
    }
  }

  const shortName = stripMinecraftNamespace(rawName)
  return {
    name: shortName,
    properties: {},
    matched: false,
    mappingSource: source,
    sourceKey: sourceKeys[0]
  }
}

module.exports = {
  convertBedrockBlock,
  getBedrockToJavaMapping
}
