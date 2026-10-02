export const SHEET_RELATIONSHIP_CODES = {
  'ADMINISTRATOR-ADMINISTRATED': 'adm',
  COLLABORATION: 'col',
  'CREATOR-CREATION': 'cre',
  'FINANCIAL (RECIPIENT-SENDER)': 'fin',
  'OWNER-TENANT': 'own',
  'PARENT-CHILD': 'par',
  'POSITION-INCUMBENT': 'pos',
  'PREDECESSOR-SUCCESSOR': 'pre',
  'REPRESENTATIVE-ELECTOR': 'rep',
};

export const EDGE_PARAMETER_FIELDS = {
  col: [
    { column: 'parameter 0', label: 'Ongoing or one-time', type: 'string' },
    { column: 'parameter 1', label: 'Closeness', type: 'integer' },
  ],
  fin: [
    { column: 'parameter 0', label: 'Upfront investment', type: 'integer' },
    { column: 'parameter 1', label: 'Ongoing funds', type: 'integer' },
    { column: 'parameter 2', label: 'Frequency', type: 'string' },
  ],
  own: [
    { column: 'parameter 0', label: 'Parcel area (sq ft)', type: 'integer' },
    { column: 'parameter 1', label: 'Lease type', type: 'string' },
  ],
  rep: [
    { column: 'parameter 0', label: 'Mode of appointment', type: 'string' },
    { column: 'parameter 1', label: 'Representative to represented ratio', type: 'integer' },
  ],
};

export function getSheetRelationshipCode(value) {
  const relationship = String(value || '').trim().toUpperCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ');
  return SHEET_RELATIONSHIP_CODES[relationship] || null;
}

export function parseEdgeParameters(row, type) {
  return (EDGE_PARAMETER_FIELDS[type] || []).flatMap(({ column, label, type: valueType }) => {
    const raw = String(row[column] || '').trim();
    if (!raw) return [];
    const numericText = raw.replace(/[$,]/g, '').match(/^[+-]?\d+(?:\.\d+)?/);
    const numeric = numericText ? Number(numericText[0]) : NaN;
    const value = valueType === 'integer' && Number.isInteger(numeric) ? numeric : raw;
    return [{ label, value }];
  });
}