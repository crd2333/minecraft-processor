const minecraftData = require('minecraft-data')
const { convertBedrockBlock } = require('./bedrockToJava')
const { stripMinecraftNamespace } = require('./structure')

const VOCAB_FORMAT = 'java-block-vocabulary-v2'
const LEGACY_VOCAB_FORMAT = 'java-block-vocabulary-v1'
const UNKNOWN_TOKEN = '__unknown__'

function isEntityBlockDescriptor (block) {
  return Boolean(block) && block.boundingBox !== 'empty'
}

function buildVersionedBlockVocabulary (version) {
  const mcData = minecraftData(version)
  if (!mcData || !Array.isArray(mcData.blocksArray)) {
    throw new Error(`Unsupported Minecraft version for vocabulary export: ${version}`)
  }

  const blocks = [...mcData.blocksArray]
    .filter(block => block && typeof block.name === 'string' && block.name.length > 0)
    .sort((left, right) => {
      const leftId = Number.isFinite(left.id) ? left.id : Number.MAX_SAFE_INTEGER
      const rightId = Number.isFinite(right.id) ? right.id : Number.MAX_SAFE_INTEGER
      if (leftId !== rightId) return leftId - rightId
      return left.name.localeCompare(right.name)
    })

  const entityNames = []
  const nonEntityNames = []
  const seen = new Set([UNKNOWN_TOKEN])

  for (const block of blocks) {
    if (seen.has(block.name)) continue
    seen.add(block.name)

    if (isEntityBlockDescriptor(block)) entityNames.push(block.name)
    else nonEntityNames.push(block.name)
  }

  const names = [UNKNOWN_TOKEN, ...entityNames, ...nonEntityNames]
  const nameToIndex = Object.fromEntries(names.map((name, index) => [name, index]))
  const flagsByName = Object.fromEntries([
    ...entityNames.map(name => [name, { isEntity: true }]),
    ...nonEntityNames.map(name => [name, { isEntity: false }]),
    [UNKNOWN_TOKEN, { isEntity: false }]
  ])

  const entityStart = 1
  const entityCount = entityNames.length
  const nonEntityStart = entityStart + entityCount
  const nonEntityCount = nonEntityNames.length

  return {
    format: VOCAB_FORMAT,
    source: 'minecraft-data',
    mcVersion: mcData.version?.minecraftVersion || version,
    unknownToken: UNKNOWN_TOKEN,
    unknownIndex: 0,
    classification: {
      label: 'entity-block',
      rule: 'minecraft-data boundingBox !== empty'
    },
    ranges: {
      entity: { start: entityStart, count: entityCount },
      nonEntity: { start: nonEntityStart, count: nonEntityCount }
    },
    size: names.length,
    names,
    entityNames,
    nonEntityNames,
    nameToIndex,
    flagsByName
  }
}

function validateBlockVocabulary (vocabulary) {
  if (!vocabulary || typeof vocabulary !== 'object') {
    throw new Error('Invalid vocabulary: expected a JSON object')
  }

  if (vocabulary.format !== VOCAB_FORMAT && vocabulary.format !== LEGACY_VOCAB_FORMAT) {
    throw new Error(`Invalid vocabulary format: expected ${VOCAB_FORMAT} or ${LEGACY_VOCAB_FORMAT}`)
  }

  if (!Array.isArray(vocabulary.names) || vocabulary.names.length === 0) {
    throw new Error('Invalid vocabulary: names must be a non-empty array')
  }

  if (!vocabulary.nameToIndex || typeof vocabulary.nameToIndex !== 'object') {
    throw new Error('Invalid vocabulary: nameToIndex must be an object')
  }

  if (vocabulary.unknownIndex !== 0 || vocabulary.names[0] !== UNKNOWN_TOKEN) {
    throw new Error(`Invalid vocabulary: index 0 must be reserved for ${UNKNOWN_TOKEN}`)
  }

  if (vocabulary.format === VOCAB_FORMAT) {
    if (!vocabulary.flagsByName || typeof vocabulary.flagsByName !== 'object') {
      throw new Error('Invalid vocabulary: flagsByName must be an object in v2 vocabularies')
    }
  }

  return vocabulary
}

function normalizeBlockNameForVocabulary (blockRecord) {
  const rawName = blockRecord?.namespaceName || blockRecord?.blockName || ''
  if (!rawName) return ''

  if (blockRecord?.source?.format === 'mcstructure-bedrock') {
    const converted = convertBedrockBlock(stripMinecraftNamespace(rawName), blockRecord.properties || {})
    return converted.name || ''
  }

  return stripMinecraftNamespace(rawName)
}

function resolveBlockIndex (blockRecord, vocabulary) {
  const name = normalizeBlockNameForVocabulary(blockRecord)
  const matched = Boolean(name) && Object.prototype.hasOwnProperty.call(vocabulary.nameToIndex, name)
  const isEntity = matched
    ? Boolean(vocabulary.flagsByName?.[name]?.isEntity)
    : false

  return {
    name,
    matched,
    isEntity,
    index: matched ? vocabulary.nameToIndex[name] : vocabulary.unknownIndex
  }
}

module.exports = {
  VOCAB_FORMAT,
  LEGACY_VOCAB_FORMAT,
  UNKNOWN_TOKEN,
  buildVersionedBlockVocabulary,
  isEntityBlockDescriptor,
  normalizeBlockNameForVocabulary,
  resolveBlockIndex,
  validateBlockVocabulary
}