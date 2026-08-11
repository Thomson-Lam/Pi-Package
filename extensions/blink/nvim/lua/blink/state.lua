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

local function same_file(a, b)
  if not a or not b then return false end
  if a.fileId and b.fileId and a.fileId == b.fileId then return true end
  if a.canonicalPath and b.canonicalPath and a.canonicalPath == b.canonicalPath then return true end
  if a.absolutePath and b.absolutePath and a.absolutePath == b.absolutePath then return true end
  if a.filesystemKey and b.filesystemKey and a.filesystemKey == b.filesystemKey then return true end
  return false
end

M.same_file = same_file

function M.replace(model, snapshot)
  model.mode = snapshot.mode or model.mode
  model.versions = {}
  model.by_id = {}
  local incoming = vim.deepcopy(snapshot.versions or {})
  table.sort(incoming, function(a, b) return a.versionId < b.versionId end)
  for _, version in ipairs(incoming) do
    local copy = vim.deepcopy(version)
    for index = #model.versions, 1, -1 do
      local old = model.versions[index]
      if same_file(old, copy) then
        model.by_id[old.versionId] = nil
        table.remove(model.versions, index)
      end
    end
    model.by_id[copy.versionId] = copy
    table.insert(model.versions, copy)
  end
  sort_versions(model)
  model.activeVersionId = #model.versions > 0 and model.versions[#model.versions].versionId or nil
  if model.activeVersionId then model.by_id[model.activeVersionId].unread = false end
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

function M.upsert(model, version, replaced_version_id)
  if model.by_id[version.versionId] then return model.by_id[version.versionId] end
  local copy = vim.deepcopy(version)
  local replaced_active = replaced_version_id ~= nil and model.activeVersionId == replaced_version_id
  for index = #model.versions, 1, -1 do
    local old = model.versions[index]
    if old.versionId == replaced_version_id or same_file(old, copy) then
      if model.activeVersionId == old.versionId then replaced_active = true end
      model.by_id[old.versionId] = nil
      table.remove(model.versions, index)
    end
  end
  model.by_id[copy.versionId] = copy
  table.insert(model.versions, copy)
  sort_versions(model)
  if replaced_active or not model.activeVersionId or not model.by_id[model.activeVersionId] then
    M.set_active(model, copy.versionId)
  else
    copy.unread = true
  end
  return copy
end

function M.add(model, version, _pane_active)
  return M.upsert(model, version, nil)
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

function M.navigate_edge(model, edge)
  if #model.versions == 0 then return nil end
  local version = edge == "first" and model.versions[1] or model.versions[#model.versions]
  return M.set_active(model, version.versionId)
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
