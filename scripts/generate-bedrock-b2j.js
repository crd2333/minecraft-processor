'use strict'

const fs = require('fs').promises
const path = require('path')

// blocksJ2B.json from https://github.com/JaylyDev/nbt-to-mcstructure/blob/7f05710c2adf7afb7d2359a8ec9de9af96a7a632/nbt-to-mcstructure/blocksJ2B.json
const SOURCE_PATH = path.resolve(__dirname, '../blocksJ2B.json')
const OUTPUT_MAP_PATH = path.resolve(__dirname, '../data/generated/blocksB2J.json')

function candidateScore (javaState) {
  let score = 0
  if (javaState.includes('waterlogged=true')) score += 4
  if (javaState.includes('snowy=true')) score += 2
  if (javaState.includes('powered=true')) score += 1
  if (javaState.includes('shape=') && !javaState.includes('shape=straight')) score += 8
  return score
}

function buildReverseMap (j2b) {
  const reverseMap = new Map()

  for (const [javaState, bedrockState] of Object.entries(j2b)) {
    const current = reverseMap.get(bedrockState)
    if (!current || candidateScore(javaState) < candidateScore(current)) {
      reverseMap.set(bedrockState, javaState)
    }
  }

  return reverseMap
}

async function main () {
  const j2b = JSON.parse(await fs.readFile(SOURCE_PATH, 'utf8'))
  const reverseMap = buildReverseMap(j2b)

  const reverseMapJson = Object.fromEntries([...reverseMap.entries()].sort(([left], [right]) => left.localeCompare(right)))

  await fs.writeFile(OUTPUT_MAP_PATH, JSON.stringify(reverseMapJson, null, 2) + '\n')

  console.log('Generated ' + path.relative(path.resolve(__dirname, '..'), OUTPUT_MAP_PATH))
  console.log('Entries:', Object.keys(reverseMapJson).length)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})