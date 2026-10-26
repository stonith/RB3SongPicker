const ALLOWED_SONG_SORT_COLUMNS = ['title', 'artist', 'album', 'origin', 'shortname', 'picks'];

// Both the browser and a full-list queue seed use shortname ASC to break ties,
// independently of the primary direction. Only allowlisted SQL identifiers enter SQL.
function songOrderBy(sort = 'title', order = 'asc', { strict = false } = {}) {
  sort = String(sort).toLowerCase();
  order = String(order).toLowerCase();
  if (strict && (!ALLOWED_SONG_SORT_COLUMNS.includes(sort) || !['asc', 'desc'].includes(order))) {
    const error = new Error('Provide a valid song sort and asc/desc direction.');
    error.code = 'INVALID_SORT';
    error.status = 400;
    throw error;
  }
  const column = ALLOWED_SONG_SORT_COLUMNS.includes(sort) ? sort : 'title';
  const direction = order === 'desc' ? 'DESC' : 'ASC';
  return `${column === 'picks' ? 'IFNULL(p.count, 0)' : `s.${column}`} ${direction}${column === 'shortname' ? '' : ', s.shortname ASC'}`;
}

module.exports = { songOrderBy };
