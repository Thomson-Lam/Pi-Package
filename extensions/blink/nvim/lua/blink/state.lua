local M = {}

function M.new(review_id, mode)
  return {
    review_id = review_id,
    mode = mode,
    versions = {},
    by_id = {},
    activeVersionId = nil,
    pinned = false,
  }
end

local function sort_versions(model)
  table.sort(model.versions, function(a, b) return a.versionId < b.versionId end)
end

function M.replace(model, snapshot)
  model.mode = snapshot.mode or model.mode
  model.versions = {}
  model.by_id = {}
  for _, version in ipairs(snapshot.versions or {}) do
    local copy = vim.deepcopy(version)
    model.by_id[copy.versionId] = copy
    table.insert(model.versions, copy)
  end
  sort_versions(model)
  if model.activeVersionId and not model.by_id[model.activeVersionId] then model.activeVersionId = nil end
  if not model.activeVersionId and #model.versions > 0 then model.activeVersionId = model.versions[#model.versions].versionId end
end

function M.set_active(model, version_id)
  if not model.by_id[version_id] then return nil end
  model.activeVersionId = version_id
  model.by_id[version_id].unread = false
  return model.by_id[version_id]
end

function M.toggle_pin(model)
  model.pinned = not model.pinned
  return model.pinned
end

function M.add(model, version, _pane_active)
  if model.by_id[version.versionId] then return model.by_id[version.versionId] end
  local copy = vim.deepcopy(version)
  model.by_id[copy.versionId] = copy
  table.insert(model.versions, copy)
  sort_versions(model)
  if not model.activeVersionId then
    M.set_active(model, copy.versionId)
  else
    copy.unread = true
  end
  return copy
end

function M.evict(model, version_id)
  local old_index
  for index, version in ipairs(model.versions) do
    if version.versionId == version_id then old_index = index; break end
  end
  if not old_index then return nil end
  model.by_id[version_id] = nil
  table.remove(model.versions, old_index)
  if model.activeVersionId == version_id then
    local replacement = model.versions[math.min(old_index, #model.versions)] or model.versions[#model.versions]
    model.activeVersionId = replacement and replacement.versionId or nil
  end
  return model.activeVersionId and model.by_id[model.activeVersionId] or nil
end

local function file_key(version)
  return version and (version.fileId or version.displayPath or version.path) or nil
end

function M.navigate_global(model, current_id, delta)
  if #model.versions == 0 then return nil end
  local index = 1
  for i, version in ipairs(model.versions) do
    if version.versionId == current_id then index = i; break end
  end
  index = ((index - 1 + delta) % #model.versions) + 1
  return M.set_active(model, model.versions[index].versionId)
end

function M.navigate_file(model, current_id, delta)
  if #model.versions == 0 then return nil end
  local current = model.by_id[current_id] or model.versions[#model.versions]
  local key = file_key(current)
  if not key then return M.navigate_global(model, current_id, delta) end
  local candidates = {}
  local current_index = 1
  for _, version in ipairs(model.versions) do
    if file_key(version) == key then
      table.insert(candidates, version)
      if version.versionId == current_id then current_index = #candidates end
    end
  end
  if #candidates == 0 then return nil end
  current_index = ((current_index - 1 + delta) % #candidates) + 1
  return M.set_active(model, candidates[current_index].versionId)
end

return M
