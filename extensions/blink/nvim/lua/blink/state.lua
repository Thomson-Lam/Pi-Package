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

local function file_key(version)
  return version.fileId or version.displayPath or version.path
end

function M.replace(model, snapshot)
  model.mode = snapshot.mode or model.mode
  model.versions = {}
  model.by_id = {}
  local latest_by_file = {}
  for _, version in ipairs(snapshot.versions or {}) do
    local copy = vim.deepcopy(version)
    local key = file_key(copy) or tostring(copy.versionId)
    local previous = latest_by_file[key]
    if not previous or copy.versionId > previous.versionId then latest_by_file[key] = copy end
  end
  for _, copy in pairs(latest_by_file) do
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

function M.add(model, version, pane_active)
  if model.by_id[version.versionId] then return model.by_id[version.versionId], {} end
  local copy = vim.deepcopy(version)
  local key = file_key(copy)
  local removed = {}
  local active_removed = false
  if key then
    for index = #model.versions, 1, -1 do
      local existing = model.versions[index]
      if file_key(existing) == key then
        if existing.versionId > copy.versionId then return existing, {} end
        table.insert(removed, existing.versionId)
        if model.activeVersionId == existing.versionId then active_removed = true end
        model.by_id[existing.versionId] = nil
        table.remove(model.versions, index)
      end
    end
  end
  model.by_id[copy.versionId] = copy
  table.insert(model.versions, copy)
  sort_versions(model)
  if active_removed or (pane_active and not model.pinned) then
    M.set_active(model, copy.versionId)
  else
    copy.unread = true
  end
  return copy, removed
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

function M.navigate_file(model, current_id, delta)
  if #model.versions == 0 then return nil end
  local index = 1
  for i, version in ipairs(model.versions) do
    if version.versionId == current_id then index = i; break end
  end
  index = ((index - 1 + delta) % #model.versions) + 1
  return M.set_active(model, model.versions[index].versionId)
end

return M
