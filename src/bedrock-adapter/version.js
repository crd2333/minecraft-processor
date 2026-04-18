'use strict'

const minecraftDataRaw = require('minecraft-data/data.js')

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

function inferSingleBedrockVersion (sourceVersions) {
  if (!Array.isArray(sourceVersions)) return null

  const uniqueVersions = new Set()
  for (const sourceVersion of sourceVersions) {
    if (sourceVersion === null || sourceVersion === undefined || sourceVersion === '') continue
    const normalized = normalizeBedrockVersionKey(sourceVersion)
    if (normalized) {
      uniqueVersions.add(normalized)
      continue
    }

    const candidates = listCandidateVersionKeys(sourceVersion)
    if (candidates[0]) uniqueVersions.add(candidates[0])
  }

  return uniqueVersions.size === 1 ? Array.from(uniqueVersions)[0] : null
}

function inferDominantBedrockVersion (sourceVersions) {
  if (!Array.isArray(sourceVersions)) {
    return {
      version: null,
      mode: 'none',
      counts: []
    }
  }

  const counts = new Map()
  const ordered = []

  for (const sourceVersion of sourceVersions) {
    if (sourceVersion === null || sourceVersion === undefined || sourceVersion === '') continue

    let normalized = normalizeBedrockVersionKey(sourceVersion)
    if (!normalized) {
      const candidates = listCandidateVersionKeys(sourceVersion)
      normalized = candidates[0] || null
    }
    if (!normalized) continue

    if (!counts.has(normalized)) {
      counts.set(normalized, 0)
      ordered.push(normalized)
    }
    counts.set(normalized, counts.get(normalized) + 1)
  }

  if (ordered.length === 0) {
    return {
      version: null,
      mode: 'none',
      counts: []
    }
  }

  const summary = ordered.map((version) => ({ version, count: counts.get(version) }))
  if (summary.length === 1) {
    return {
      version: summary[0].version,
      mode: 'single',
      counts: summary
    }
  }

  let dominant = summary[0]
  for (const entry of summary.slice(1)) {
    if (entry.count > dominant.count) dominant = entry
  }

  return {
    version: dominant.version,
    mode: 'mixed',
    counts: summary
  }
}

module.exports = {
  decodeBedrockVersionNumber,
  inferDominantBedrockVersion,
  listCandidateVersionKeys,
  normalizeBedrockVersionKey,
  inferSingleBedrockVersion
}
