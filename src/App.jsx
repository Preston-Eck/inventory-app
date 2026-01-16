import {
  Upload, FileText, Filter, RefreshCw, Check, Search,
  MinusCircle, PlusCircle, ArrowUpDown, Download,
  Layers, List, Square, CheckSquare, Plus, Trash2
} from 'lucide-react';
import * as XLSX from 'xlsx';

// --- IndexedDB Helper (For Local Persistence) ---
const DB_NAME = 'InventoryForecasterDB';
const STORE_NAME = 'files';

const openDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const saveToDB = async (key, data) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(data, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const loadFromDB = async (key) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const clearDB = async () => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

// --- Helper: Robust CSV Parser ---
const parseCSV = (text) => {
  const rows = [];
  let currentRow = [];
  let currentVal = '';
  let insideQuote = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (insideQuote && nextChar === '"') {
        currentVal += '"';
        i++;
      } else {
        insideQuote = !insideQuote;
      }
    } else if (char === ',' && !insideQuote) {
      currentRow.push(currentVal.trim());
      currentVal = '';
    } else if ((char === '\n' || char === '\r') && !insideQuote) {
      if (char === '\r' && nextChar === '\n') i++;
      currentRow.push(currentVal.trim());
      if (currentRow.length > 0) rows.push(currentRow);
      currentRow = [];
      currentVal = '';
    } else {
      currentVal += char;
    }
  }
  if (currentRow.length > 0) rows.push(currentRow);
  return rows;
};

// --- Helper: Pre-process Malformed CSV ---
// Fixes issues where newlines exist in unquoted fields (splitting rows incorrectly)
const repairMalformatedCSV = (text, type) => {
  if (type === 'inventory') {
    // Inventory rows start with a hex UID (usually 8+ chars)
    // We assume any newline NOT followed by a valid UID pattern (8+ hex chars then comma) is a broken newline.
    return text.replace(/\r?\n(?![0-9a-fA-F]{8,},)/g, ' ');
  }
  return text;
};

// --- Helper: Data Cleaning ---
const cleanHeader = (h) => (h || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

const normalizeData = (rows, type) => {
  if (!rows || rows.length < 2) return [];

  const headers = rows[0].map(cleanHeader);
  const data = [];

  const map = {};
  headers.forEach((h, i) => {
    if (h.includes('property')) map.location = i;
    else if (type === 'sales' && h.includes('salesdate') && !h.includes('last')) map.date = i;
    else if (type === 'inventory' && (h.includes('counttimestamp') || (h.includes('date') && !h.includes('sales')))) map.date = i;
    else if (h.includes('sku')) map.sku = i;
    else if (type === 'sales' && (h.includes('originaltitle') || h.includes('itemname'))) map.description = i;
    else if (type === 'inventory' && h.includes('itemname')) map.description = i;
    else if (type === 'sales' && h.includes('qtysold') || h.includes('quantity')) map.quantity = i;
    else if (type === 'sales' && h.includes('department')) map.department = i;
    else if (type === 'inventory' && h.includes('department')) map.department = i;
    else if (type === 'inventory' && (h.includes('countedqty') || h === 'count' || (h.includes('qty') && h.includes('count')))) map.count = i;
  });

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < headers.length) continue;

    const item = {
      location: row[map.location],
      date: new Date(row[map.date]),
      sku: (row[map.sku] || '').toString().replace(/^0+/, ''),
    };

    if (item.location === 'ALG') continue;
    if (isNaN(item.date.getTime())) continue;

    if (type === 'sales') {
      item.description = row[map.description];
      item.department = row[map.department] || 'Unknown';
      let qty = (row[map.quantity] || '0').replace(/,/g, '');
      item.quantity = parseFloat(qty) || 0;
      data.push(item);
    } else {
      item.description = row[map.description] || '';
      item.department = row[map.department] || 'Unknown';
      let count = (row[map.count] || '0').replace(/,/g, '');
      item.count = parseFloat(count) || 0;
      data.push(item);
    }
  }
  return data;
};

// --- Helper: Keyword Matching ---
const checkKeywords = (text, includeStr, excludeStr) => {
  const normalize = t => (t || '').toLowerCase();
  const target = normalize(text);

  if (excludeStr) {
    const excludes = excludeStr.split(',').map(s => normalize(s.trim())).filter(Boolean);
    if (excludes.some(ex => target.includes(ex))) return false;
  }

  if (includeStr) {
    const includes = includeStr.split(',').map(s => normalize(s.trim())).filter(Boolean);
    if (includes.length > 0) {
      return includes.some(inc => target.includes(inc));
    }
  }
  return true;
};

export default function App() {
  const [salesFile, setSalesFile] = useState(null);
  const [invFile, setInvFile] = useState(null);
  const [reportData, setReportData] = useState([]);
  const [isProcessing, setIsProcessing] = useState(true); // Start true while checking DB
  const [activeTab, setActiveTab] = useState('list');

  // State for Selection & Summaries
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [summaries, setSummaries] = useState([]);
  const [summaryNameInput, setSummaryNameInput] = useState('');
  const [showNameModal, setShowNameModal] = useState(false);
  const [selectedSummary, setSelectedSummary] = useState(null); // For drill-down modal
  const [modalSearch, setModalSearch] = useState('');

  // State for Filters
  const [activeFilters, setActiveFilters] = useState({
    campground: [],
    department: [],
    vendor: [],
    itemSku: '',
    itemIncludes: '',
    itemExcludes: '',
    descIncludes: '',
    descExcludes: '',
    qtyMin: '',
    qtyMax: '',
    stockMin: '',
    stockMax: ''
  });

  // State for Sorting
  const [sortConfig, setSortConfig] = useState({ key: 'Purchase', direction: 'desc' });

  // --- Initialize: Load from DB & LocalStorage ---
  useEffect(() => {
    const initData = async () => {
      try {
        const savedSales = await loadFromDB('sales');
        const savedInv = await loadFromDB('inventory');

        if (savedSales && savedInv) {
          savedSales.forEach(r => r.date = new Date(r.date));
          savedInv.forEach(r => r.date = new Date(r.date));
          setSalesFile(savedSales);
          setInvFile(savedInv);
        }

        // Load Summaries
        const savedSummaries = localStorage.getItem('inventory_summaries');
        if (savedSummaries) {
          setSummaries(JSON.parse(savedSummaries));
        }

        // Load Filters
        const savedFilters = localStorage.getItem('inventory_filters');
        if (savedFilters) {
          setActiveFilters(JSON.parse(savedFilters));
        }

        // Load Selection
        const savedSelection = localStorage.getItem('inventory_selection');
        if (savedSelection) {
          setSelectedIds(new Set(JSON.parse(savedSelection)));
        }

      } catch (e) {
        console.error("Failed to load persistence:", e);
      } finally {
        setIsProcessing(false);
      }
    };
    initData();
  }, []);

  // --- Persistence Effects ---
  useEffect(() => {
    localStorage.setItem('inventory_summaries', JSON.stringify(summaries));
  }, [summaries]);

  useEffect(() => {
    localStorage.setItem('inventory_filters', JSON.stringify(activeFilters));
  }, [activeFilters]);

  useEffect(() => {
    localStorage.setItem('inventory_selection', JSON.stringify([...selectedIds]));
  }, [selectedIds]);

  // --- File Handler ---
  const handleFileUpload = (e, type) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsProcessing(true);
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const rows = parseCSV(evt.target.result);
      const data = normalizeData(rows, type);

      // Save to State AND DB
      if (type === 'sales') {
        setSalesFile(data);
        await saveToDB('sales', data);
      } else {
        setInvFile(data);
        await saveToDB('inventory', data);
      }
      setIsProcessing(false);
    };
    reader.readAsText(file);
  };

  const handleClearData = async () => {
    if (window.confirm("Are you sure you want to clear all data and start over?")) {
      await clearDB();
      setSalesFile(null);
      setInvFile(null);
      setReportData([]);
      setSummaries([]);
      window.location.reload();
    }
  };

  // --- Core Processing ---
  useEffect(() => {
    if (!salesFile || !invFile) return;
    setIsProcessing(true);

    setTimeout(() => {
      try {
        const seasonalSales = salesFile.filter(row => {
          const month = row.date.getMonth() + 1;
          return month >= 4 && month <= 10;
        });

        const years = new Set(seasonalSales.map(r => r.date.getFullYear()));
        const uniqueYears = Math.max(years.size, 1);

        const demandMap = {};
        seasonalSales.forEach(row => {
          const key = `${row.location}|${row.sku}`;
          if (!demandMap[key]) {
            demandMap[key] = {
              qty: 0,
              desc: row.description,
              dept: row.department,
              location: row.location,
              sku: row.sku
            };
          }
          demandMap[key].qty += row.quantity;
        });

        const lastDate = salesFile.reduce((max, r) => r.date > max ? r.date : max, new Date(0));
        const cutoff = new Date(lastDate);
        cutoff.setFullYear(cutoff.getFullYear() - 1);

        const sales12moMap = {};
        salesFile.forEach(row => {
          if (row.date >= cutoff) {
            const key = `${row.location}|${row.sku}`;
            sales12moMap[key] = (sales12moMap[key] || 0) + row.quantity;
          }
        });

        const sortedInv = [...invFile].sort((a, b) => b.date - a.date);
        const invMap = {};
        sortedInv.forEach(row => {
          const key = `${row.location}|${row.sku}`;
          if (invMap[key] === undefined) {
            invMap[key] = {
              count: row.count,
              desc: row.description,
              dept: row.department
            };
          }
        });

        const report = [];
        const allKeys = new Set([...Object.keys(demandMap), ...Object.keys(invMap)]);

        allKeys.forEach(key => {
          const demand = demandMap[key];
          const invRec = invMap[key];

          const forecast = demand ? Math.floor(demand.qty / uniqueYears) : 0;
          const onHand = invRec ? invRec.count : 0;
          const qtySold12 = sales12moMap[key] || 0;

          // If item has NO forecast demand, we generally don't buy it unless we want to stock new items.
          // BUT the user wants to see accurate stock counts.
          // Calculation: Forecast - OnHand. If negative, 0.
          let toBuy = forecast - onHand;
          if (toBuy < 0) toBuy = 0;

          // We usually filter if (toBuy > 0). 
          // However, if the user sees "Total Stock" is wrong, it means they expect to see these items even if Purchase is 0?
          // The previous code filtered: if (toBuy > 0) report.push(...)
          // The user complained "Total Apparel Stock for MGC is 32 (inaccurate)".
          // This implies they want to see the stock counts aggregated in the totals at the bottom, 
          // essentially the report should list EVERYTHING or at least everything actively stocked?
          // If we filter (toBuy > 0), we hide items that are fully stocked.
          // That might be the source of confusion too? 
          // Let's assume for this "Forecaster" tool, the main view is "What to Buy".
          // BUT the "Totals" at the bottom show "Total Stock". If we hide items with 0 purchase, 
          // we are hiding valid stock from the "Total Stock" counter.
          // AND the filter in the UI says "Selection: X items". 
          // If we want "Total Stock" to be accurate for the facility, we should probably listing everything, 
          // OR the "Total Stock" in the UI should be a separate calculation (unlikely as it sums the rows).
          // For now, I will modify to showing items if (toBuy > 0 OR onHand > 0).

          if (toBuy > 0 || onHand > 0) {
            let desc = '';
            let dept = '';
            let sku = '';
            let loc = '';

            if (demand) {
              desc = demand.desc;
              dept = demand.dept;
              sku = demand.sku;
              loc = demand.location;
            } else if (invRec) {
              // Parse from cached inventory row or key
              desc = invRec.desc || '';
              dept = invRec.dept || '';
              // Key is LOC|SKU
              const parts = key.split('|');
              loc = parts[0];
              sku = parts[1];
            }

            let posName = desc || '';
            if (posName.startsWith('_')) posName = posName.substring(1);
            const nameParts = posName.split('_');

            report.push({
              id: key,
              Campground: loc,
              Department: dept,
              SKU: sku,
              Item: nameParts[0] || '',
              Vendor: nameParts[1] || '',
              Description: nameParts[2] || '',
              QTYSold: qtySold12,
              InStock: onHand,
              Forecast: forecast,
              Purchase: toBuy
            });
          }
        });
        setReportData(report);
      } catch (err) {
        console.error(err);
      } finally {
        setIsProcessing(false);
      }
    }, 100);
  }, [salesFile, invFile]);

  // --- Filtering & Sorting ---
  const filterOptions = useMemo(() => {
    const allCamps = new Set(reportData.map(r => r.Campground));
    const activeCamps = activeFilters.campground;
    const depts = new Set();
    const activeDepts = activeFilters.department;
    const vendors = new Set();

    reportData.forEach(row => {
      const matchCamp = activeCamps.length === 0 || activeCamps.includes(row.Campground);
      const matchDept = activeDepts.length === 0 || activeDepts.includes(row.Department);

      if (matchCamp) depts.add(row.Department);
      if (matchCamp && matchDept) vendors.add(row.Vendor);
    });

    return {
      campground: Array.from(allCamps).sort(),
      department: Array.from(depts).sort(),
      vendor: Array.from(vendors).sort()
    };
  }, [reportData, activeFilters.campground, activeFilters.department]);

  const filteredData = useMemo(() => {
    let data = reportData.filter(row => {
      // Text Filters
      if (activeFilters.itemSku && !row.SKU.toLowerCase().includes(activeFilters.itemSku.toLowerCase())) return false;
      if (!checkKeywords(row.Item, activeFilters.itemIncludes, activeFilters.itemExcludes)) return false;
      if (!checkKeywords(row.Description, activeFilters.descIncludes, activeFilters.descExcludes)) return false;

      // Category Filters
      if (activeFilters.campground.length && !activeFilters.campground.includes(row.Campground)) return false;
      if (activeFilters.department.length && !activeFilters.department.includes(row.Department)) return false;
      if (activeFilters.vendor.length && !activeFilters.vendor.includes(row.Vendor)) return false;

      // Numeric Filters
      if (activeFilters.qtyMin !== '' && row.QTYSold < parseFloat(activeFilters.qtyMin)) return false;
      if (activeFilters.qtyMax !== '' && row.QTYSold > parseFloat(activeFilters.qtyMax)) return false;
      if (activeFilters.stockMin !== '' && row.InStock < parseFloat(activeFilters.stockMin)) return false;
      if (activeFilters.stockMax !== '' && row.InStock > parseFloat(activeFilters.stockMax)) return false;

      return true;
    });

    if (sortConfig.key) {
      data.sort((a, b) => {
        if (a[sortConfig.key] < b[sortConfig.key]) return sortConfig.direction === 'asc' ? -1 : 1;
        if (a[sortConfig.key] > b[sortConfig.key]) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return data;
  }, [reportData, activeFilters, sortConfig]);

  // --- Auto-Selection Logic ---
  useEffect(() => {
    const allVisibleIds = new Set(filteredData.map(r => r.id));
    setSelectedIds(allVisibleIds);
  }, [filteredData]);

  const totals = useMemo(() => {
    return filteredData.reduce((acc, row) => {
      if (selectedIds.has(row.id)) {
        return {
          sold: acc.sold + row.QTYSold,
          stock: acc.stock + row.InStock,
          forecast: acc.forecast + row.Forecast,
          purchase: acc.purchase + row.Purchase
        };
      }
      return acc;
    }, { sold: 0, stock: 0, forecast: 0, purchase: 0 });
  }, [filteredData, selectedIds]);

  // --- Handlers ---
  const toggleFilter = (category, value) => {
    setActiveFilters(prev => {
      const current = prev[category];
      const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
      return { ...prev, [category]: next };
    });
  };

  const handleTextFilter = (field, value) => {
    setActiveFilters(prev => ({ ...prev, [field]: value }));
  };

  const resetAllFilters = () => {
    setActiveFilters({
      campground: [], department: [], vendor: [],
      itemSku: '', itemIncludes: '', itemExcludes: '', descIncludes: '', descExcludes: '',
      qtyMin: '', qtyMax: '', stockMin: '', stockMax: ''
    });
  };

  const handleSort = (key) => {
    setSortConfig(current => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const toggleSelection = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredData.length) {
      setSelectedIds(new Set()); // Deselect all
    } else {
      setSelectedIds(new Set(filteredData.map(r => r.id))); // Select all
    }
  };

  const createSummary = () => {
    const name = summaryNameInput.trim() || `Summary ${summaries.length + 1}`;

    // Calculate total lines (count of selected rows)
    const summaryItems = filteredData.filter(r => selectedIds.has(r.id));
    const lineCount = summaryItems.length;

    if (lineCount === 0) {
      alert("No items selected!");
      return;
    }

    const newSummary = {
      id: Date.now(),
      name: name,
      date: new Date().toLocaleDateString(),
      lineItems: lineCount,
      totalSold: totals.sold,
      totalStock: totals.stock,
      totalForecast: totals.forecast,
      totalPurchase: totals.purchase,
      items: summaryItems
    };

    setSummaries([...summaries, newSummary]);
    setSummaryNameInput('');
    setShowNameModal(false);
    setActiveTab('summary'); // Switch tab
  };

  const deleteSummary = (id) => {
    if (window.confirm("Are you sure you want to delete this summary?")) {
      setSummaries(summaries.filter(s => s.id !== id));
    }
  };

  const handleExportReport = () => {
    const fileName = prompt("Enter filename for Report Table:", `Summary_Report_${new Date().toISOString().slice(0, 10)}`);
    if (!fileName) return;

    const data = summaries.map(s => ({
      "Summary Name": s.name,
      "Date": s.date,
      "Line Items": s.lineItems,
      "Total Sold (12mo)": s.totalSold,
      "Total In Stock": s.totalStock,
      "Total Forecast": s.totalForecast,
      "Total Purchase": s.totalPurchase
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Summaries");
    XLSX.writeFile(wb, `${fileName}.xlsx`);
  };

  const handleExportBackup = () => {
    const fileName = prompt("Enter filename for Backup Excel:", `Inventory_Backup_${new Date().toISOString().slice(0, 10)}`);
    if (!fileName) return;

    const data = [];
    summaries.forEach(s => {
      s.items.forEach(item => {
        data.push({
          "Summary Name": s.name,
          "Summary Date": s.date,
          "SKU": item.SKU,
          "Item": item.Item,
          "Vendor": item.Vendor,
          "Description": item.Description,
          "QTY Sold": item.QTYSold,
          "In Stock": item.InStock,
          "Forecast": item.Forecast,
          "Purchase": item.Purchase,
          "Campground": item.Campground,
          "Department": item.Department
        });
      });
    });

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Backup_Data");
    XLSX.writeFile(wb, `${fileName}.xlsx`);
  };

  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      let rows = [];
      // Detect file type and parse accordingly
      if (file.name.endsWith('.csv')) {
        rows = parseCSV(evt.target.result);
      } else {
        const data = new Uint8Array(evt.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        rows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
      }

      if (rows.length === 0) return;

      // Check columns to determine format type
      const sample = rows[0];
      // Normalize keys for check
      const keys = Object.keys(sample).map(k => k.toLowerCase().trim());

      const hasSKU = keys.includes("sku");
      const hasSummaryName = keys.some(k => k.includes("summary name"));

      if (!hasSummaryName) {
        alert("Invalid file format. Missing 'Summary Name' column.");
        return;
      }

      const groups = {};

      // Helper to find value case-insensitively
      const getVal = (row, keyPart) => {
        const key = Object.keys(row).find(k => k.toLowerCase().includes(keyPart));
        return key ? row[key] : undefined;
      };

      rows.forEach((row, i) => {
        const name = getVal(row, "summary name");
        if (!groups[name]) {
          groups[name] = {
            id: Date.now() + i,
            name: name,
            date: getVal(row, "date") || new Date().toLocaleDateString(),
            items: [],
            totalSold: parseFloat(getVal(row, "sold") || 0),
            totalStock: parseFloat(getVal(row, "stock") || 0),
            totalForecast: parseFloat(getVal(row, "forecast") || 0),
            totalPurchase: parseFloat(getVal(row, "purchase") || 0),
            // If legacy, we might read these totals directly. If backup, we recalc.
            isLegacy: !hasSKU
          };
        }

        if (hasSKU) {
          // Detailed Backup - Reconstruct items
          const item = {
            id: `${getVal(row, "campground")}|${getVal(row, "sku")}`,
            SKU: String(getVal(row, "sku")),
            Item: getVal(row, "item"),
            Vendor: getVal(row, "vendor"),
            Description: getVal(row, "description"),
            QTYSold: parseFloat(getVal(row, "qty sold") || 0),
            InStock: parseFloat(getVal(row, "in stock") || 0),
            Forecast: parseFloat(getVal(row, "forecast") || 0),
            Purchase: parseFloat(getVal(row, "purchase") || 0),
            Campground: getVal(row, "campground"),
            Department: getVal(row, "department")
          };
          groups[name].items.push(item);

          // If it's a detailed backup, we should probably recalc totals from items to be safe 
          // OR trust the row if the row was flat? 
          // The Backup Format is flat rows. So each row adds to the total if we sum them up.
          // BUT my export logic wrote the totals to EVERY row? verify.
          // My Export Backup writes: Summary Name... SKU... 
          // It does NOT write Summary Totals to every row. Wait.
          // Let's check ExportBackup again.
        }
      });

      // Recalculate totals for Detailed Backups (since we just pushed items)
      if (hasSKU) {
        Object.values(groups).forEach(g => {
          g.totalSold = g.items.reduce((sum, i) => sum + i.QTYSold, 0);
          g.totalStock = g.items.reduce((sum, i) => sum + i.InStock, 0);
          g.totalForecast = g.items.reduce((sum, i) => sum + i.Forecast, 0);
          g.totalPurchase = g.items.reduce((sum, i) => sum + i.Purchase, 0);
        });
      }

      const newSummaries = Object.values(groups).map(g => ({
        ...g,
        lineItems: hasSKU ? g.items.length : (parseFloat(g.lineItems) || 0) // Legacy has lineItems column? Yes
      }));

      setSummaries(prev => [...prev, ...newSummaries]);
      alert(`Imported ${newSummaries.length} summaries successfully!`);

    } catch (err) {
      console.error("Import failed:", err);
      alert("Failed to import: " + err.message);
    }
  };

  if (file.name.endsWith('.csv')) {
    reader.readAsText(file);
  } else {
    reader.readAsArrayBuffer(file);
  }
  e.target.value = null; // Reset input
};

const handleLoadLocalData = async () => {
  try {
    setIsProcessing(true);

    const salesRes = await fetch('/data/sales.csv');
    const salesText = await salesRes.text();
    const salesData = normalizeData(parseCSV(salesText), 'sales');
    setSalesFile(salesData);
    await saveToDB('sales', salesData);

    const invRes = await fetch('/data/inventory.csv');
    const invRaw = await invRes.text();
    const invRepaired = repairMalformatedCSV(invRaw, 'inventory');
    const invData = normalizeData(parseCSV(invRepaired), 'inventory');
    setInvFile(invData);
    await saveToDB('inventory', invData);

    setIsProcessing(false);
  } catch (err) {
    console.error("Failed to load local data:", err);
    alert("Failed to load local data: " + err.message);
    setIsProcessing(false);
  }
};

if (!salesFile || !invFile) {
  return <UploadScreen onUpload={handleFileUpload} sales={salesFile} inv={invFile} onLoadLocal={handleLoadLocalData} />;
}

return (
  <div className="h-screen overflow-hidden bg-slate-100 flex flex-col font-sans">
    {/* --- Top Bar & Navigation --- */}
    <header className="bg-white border-b shadow-sm flex-none z-20">
      <div className="px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded-lg">
            <RefreshCw className={`w-5 h-5 text-white ${isProcessing ? 'animate-spin' : ''}`} />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800">Inventory Forecaster</h1>
          </div>
        </div>
        <div className="flex gap-2">
          <TabButton icon={List} label="Inventory List" active={activeTab === 'list'} onClick={() => setActiveTab('list')} />
          <TabButton icon={Layers} label="Summary Reports" active={activeTab === 'summary'} onClick={() => setActiveTab('summary')} count={summaries.length} />
          <div className="h-8 w-px bg-slate-200 mx-2"></div>
          <label className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg hover:bg-blue-700 shadow-sm cursor-pointer text-sm font-medium transition-colors">
            <Upload className="w-4 h-4" /> Import Backup
            <input type="file" accept=".xlsx, .xls, .csv" className="hidden" onChange={handleImportBackup} />
          </label>
          <button
            onClick={handleClearData}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 border border-transparent hover:border-red-200 transition-colors"
            title="Clear all data and start over"
          >
            <Trash2 className="w-4 h-4" /> Reset
          </button>
        </div>
      </div>
    </header>

    {/* --- Main Content Area --- */}
    {activeTab === 'list' ? (
      <div className="flex-1 overflow-hidden flex">
        {/* Sidebar */}
        <aside className="w-80 bg-white border-r overflow-y-auto p-4 flex flex-col gap-6 shrink-0 shadow-inner">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2">
              <Filter className="w-4 h-4" /> Filters
            </h2>
            <button onClick={resetAllFilters} className="text-xs text-blue-600 hover:underline">
              Reset All
            </button>
          </div>

          <div className="space-y-4 border-b pb-6">
            <div>
              <label className="text-xs font-semibold text-slate-700 uppercase tracking-wider block mb-1">SKU</label>
              <input
                type="text"
                placeholder="Search SKU..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 outline-none"
                value={activeFilters.itemSku}
                onChange={(e) => handleTextFilter('itemSku', e.target.value)}
              />
            </div>
            <TextFilterGroup label="Item Name" includeVal={activeFilters.itemIncludes} excludeVal={activeFilters.itemExcludes} onIncludeChange={(v) => handleTextFilter('itemIncludes', v)} onExcludeChange={(v) => handleTextFilter('itemExcludes', v)} />
            <TextFilterGroup label="Description" includeVal={activeFilters.descIncludes} excludeVal={activeFilters.descExcludes} onIncludeChange={(v) => handleTextFilter('descIncludes', v)} onExcludeChange={(v) => handleTextFilter('descExcludes', v)} />
          </div>

          <div className="space-y-4 border-b pb-6">
            <div className="text-xs font-semibold text-slate-700 uppercase tracking-wider">Numeric Ranges</div>
            <NumericRangeFilter label="QTY Sold (12mo)" minVal={activeFilters.qtyMin} maxVal={activeFilters.qtyMax} onMinChange={(v) => handleTextFilter('qtyMin', v)} onMaxChange={(v) => handleTextFilter('qtyMax', v)} />
            <NumericRangeFilter label="In Stock" minVal={activeFilters.stockMin} maxVal={activeFilters.stockMax} onMinChange={(v) => handleTextFilter('stockMin', v)} onMaxChange={(v) => handleTextFilter('stockMax', v)} />
          </div>

          <FilterSection title="Campground" options={filterOptions.campground} selected={activeFilters.campground} onToggle={(val) => toggleFilter('campground', val)} />
          <FilterSection title="Department" options={filterOptions.department} selected={activeFilters.department} onToggle={(val) => toggleFilter('department', val)} searchable />
          <FilterSection title="Brand / Vendor" options={filterOptions.vendor} selected={activeFilters.vendor} onToggle={(val) => toggleFilter('vendor', val)} searchable />
        </aside>

        {/* Table Area */}
        <main className="flex-1 overflow-y-auto p-6 relative">
          <div className="bg-white rounded-lg shadow border border-slate-200 overflow-hidden mb-16">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-slate-50 text-slate-600 font-semibold border-b sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-3 w-10 text-center min-w-[40px]">
                      <button onClick={toggleSelectAll} className="hover:text-blue-600">
                        {selectedIds.size === filteredData.length && filteredData.length > 0 ? <CheckSquare className="w-4 h-4 text-blue-600" /> : <Square className="w-4 h-4 text-slate-400" />}
                      </button>
                    </th>
                    <th className="px-4 py-3 min-w-[120px]">Campground</th>
                    <th className="px-4 py-3 min-w-[120px]">Department</th>
                    <SortableHeader label="SKU" sortKey="SKU" currentSort={sortConfig} onSort={handleSort} />
                    <th className="px-4 py-3 min-w-[150px]">Item</th>
                    <th className="px-4 py-3 min-w-[150px]">Brand/Vendor</th>
                    <th className="px-4 py-3 min-w-[200px]">Description</th>
                    <SortableHeader label="QTY Sold (12mo)" sortKey="QTYSold" currentSort={sortConfig} onSort={handleSort} className="min-w-[140px] text-right" />
                    <SortableHeader label="In Stock" sortKey="InStock" currentSort={sortConfig} onSort={handleSort} className="min-w-[100px] text-right" />
                    <SortableHeader label="Forecast" sortKey="Forecast" currentSort={sortConfig} onSort={handleSort} className="min-w-[100px] text-right" />
                    <SortableHeader label="Purchase" sortKey="Purchase" currentSort={sortConfig} onSort={handleSort} className="bg-blue-50 text-blue-800 min-w-[100px] text-right" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredData.map((row) => {
                    const isSelected = selectedIds.has(row.id);
                    return (
                      <tr key={row.id} className={`hover:bg-slate-50 transition-colors ${!isSelected ? 'opacity-50 grayscale' : ''}`}>
                        <td className="px-3 py-2 text-center">
                          <button onClick={() => toggleSelection(row.id)}>
                            {isSelected ? <CheckSquare className="w-4 h-4 text-blue-600" /> : <Square className="w-4 h-4 text-slate-300" />}
                          </button>
                        </td>
                        <td className="px-4 py-2 font-medium text-slate-800">{row.Campground}</td>
                        <td className="px-4 py-2 text-slate-600">{row.Department}</td>
                        <td className="px-4 py-2 font-mono text-xs text-slate-500">{row.SKU}</td>
                        <td className="px-4 py-2 text-slate-800 font-medium">{row.Item}</td>
                        <td className="px-4 py-2 text-slate-600">{row.Vendor}</td>
                        <td className="px-4 py-2 text-slate-500 truncate max-w-xs">{row.Description}</td>
                        <td className="px-4 py-2 text-right font-mono">{row.QTYSold.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right font-mono text-slate-500">{row.InStock}</td>
                        <td className="px-4 py-2 text-right font-mono text-slate-500">{row.Forecast.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right font-mono font-bold bg-blue-50 text-blue-800 border-l border-blue-100">
                          {row.Purchase.toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredData.length === 0 && (
                    <tr><td colSpan="10" className="p-8 text-center text-slate-400">No items match your filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Floating Action Footer */}
          <div className="fixed bottom-6 right-8 left-[22rem] bg-white border border-slate-200 shadow-xl rounded-xl p-4 flex items-center justify-between z-20 animate-in slide-in-from-bottom-4">
            <div className="flex items-center gap-6">
              <div>
                <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Selection</span>
                <div className="text-lg font-bold text-slate-800">{selectedIds.size} <span className="text-sm font-normal text-slate-500">items</span></div>
              </div>
              <div className="h-8 w-px bg-slate-200"></div>
              <div className="flex gap-6 text-sm">
                <div>
                  <div className="text-slate-500 text-xs">Total Sold</div>
                  <div className="font-semibold">{totals.sold.toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs">Total Stock</div>
                  <div className="font-semibold">{totals.stock.toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs">Total Forecast</div>
                  <div className="font-semibold">{totals.forecast.toLocaleString()}</div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="bg-blue-50 px-4 py-2 rounded-lg text-right">
                <div className="text-xs text-blue-600 font-semibold uppercase">Total Purchase</div>
                <div className="text-xl font-bold text-blue-800">{totals.purchase.toLocaleString()}</div>
              </div>
              <button
                onClick={() => setShowNameModal(true)}
                className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-3 rounded-lg font-semibold shadow-lg hover:shadow-blue-200 transition-all flex items-center gap-2"
              >
                <Plus className="w-5 h-5" /> Create Summary Group
              </button>
            </div>
          </div>
        </main>
      </div>
    ) : (
      /* --- Summary Reports Tab --- */
      <div className="flex-1 bg-slate-50 p-8 overflow-y-auto">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-slate-800">Saved Summary Groups</h2>
            <div className="flex gap-2">
              <button
                onClick={handleExportReport}
                disabled={summaries.length === 0}
                className="flex items-center gap-2 bg-white border border-slate-300 text-slate-700 px-4 py-2 rounded-lg hover:bg-slate-50 disabled:opacity-50 shadow-sm"
              >
                <Download className="w-4 h-4" /> Export Table
              </button>
              <button
                onClick={handleExportBackup}
                disabled={summaries.length === 0}
                className="flex items-center gap-2 bg-white border border-slate-300 text-slate-700 px-4 py-2 rounded-lg hover:bg-slate-50 disabled:opacity-50 shadow-sm"
              >
                <Download className="w-4 h-4" /> Export Backup
              </button>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <table className="w-full text-sm text-left">
              <thead className="bg-slate-50 text-slate-600 border-b sticky top-0 z-10">
                <tr>
                  <th className="px-6 py-4">Summary Name</th>
                  <th className="px-6 py-4">Date Created</th>
                  <th className="px-6 py-4 text-right">Line Items</th>
                  <th className="px-6 py-4 text-right">Total Sold (12mo)</th>
                  <th className="px-6 py-4 text-right">Total In Stock</th>
                  <th className="px-6 py-4 text-right">Total Forecast</th>
                  <th className="px-6 py-4 text-right bg-blue-50 text-blue-800">Total Purchase</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {summaries.map((s) => (
                  <tr
                    key={s.id}
                    className="hover:bg-slate-50 cursor-pointer group"
                    onClick={() => {
                      setModalSearch('');
                      setSelectedSummary(s);
                    }}
                  >
                    <td className="px-6 py-4 font-bold text-slate-800 flex items-center gap-2">
                      {s.name}
                    </td>
                    <td className="px-6 py-4 text-slate-500">{s.date}</td>
                    <td className="px-6 py-4 text-right font-mono">{s.lineItems}</td>
                    <td className="px-6 py-4 text-right font-mono">{s.totalSold.toLocaleString()}</td>
                    <td className="px-6 py-4 text-right font-mono">{s.totalStock.toLocaleString()}</td>
                    <td className="px-6 py-4 text-right font-mono">{s.totalForecast.toLocaleString()}</td>
                    <td className="px-6 py-4 text-right font-mono font-bold bg-blue-50 text-blue-800 border-l border-blue-100">
                      {s.totalPurchase.toLocaleString()}
                    </td>
                    <td className="px-6 py-4 text-right w-10">
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteSummary(s.id); }}
                        className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors opacity-0 group-hover:opacity-100"
                        title="Delete Summary"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
                {summaries.length === 0 && (
                  <tr><td colSpan="8" className="p-12 text-center text-slate-400">No summaries created yet. Go to the "Inventory List" tab to create one.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    )}

    {/* --- Name Prompt Modal --- */}
    {showNameModal && (
      <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 backdrop-blur-sm">
        <div className="bg-white p-6 rounded-xl shadow-2xl w-96 animate-in zoom-in-95">
          <h3 className="text-lg font-bold mb-4">Name this Summary</h3>
          <input
            type="text"
            autoFocus
            placeholder="e.g. MGC Toys Order..."
            className="w-full border border-slate-300 rounded-lg p-3 mb-6 focus:ring-2 focus:ring-blue-500 outline-none"
            value={summaryNameInput}
            onChange={(e) => setSummaryNameInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createSummary()}
          />
          <div className="flex justify-end gap-3">
            <button onClick={() => setShowNameModal(false)} className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg">Cancel</button>
            <button onClick={createSummary} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium">Create</button>
          </div>
        </div>
      </div>
    )}

    {/* --- Summary Detail Modal --- */}
    {selectedSummary && (
      <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 backdrop-blur-sm" onClick={() => setSelectedSummary(null)}>
        <div className="bg-white rounded-xl shadow-2xl w-[90%] max-w-4xl max-h-[90vh] flex flex-col animate-in zoom-in-95" onClick={e => e.stopPropagation()}>
          <div className="px-6 py-4 border-b flex items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-bold text-slate-800">{selectedSummary.name}</h3>
              <p className="text-sm text-slate-500">{selectedSummary.date} • {selectedSummary.lineItems} items</p>
            </div>
            <div className="flex items-center gap-4 flex-1 justify-end">
              <div className="relative">
                <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search in summary..."
                  className="pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none w-64"
                  value={modalSearch}
                  onChange={(e) => setModalSearch(e.target.value)}
                />
              </div>
              <button onClick={() => setSelectedSummary(null)} className="p-2 hover:bg-slate-100 rounded-lg">
                <MinusCircle className="w-5 h-5 text-slate-400" />
              </button>
            </div>
          </div>
          <div className="overflow-auto p-0 flex-1">
            <table className="w-full text-sm text-left">
              <thead className="bg-slate-50 text-slate-600 sticky top-0 border-b shadow-sm">
                <tr>
                  <th className="px-4 py-2 bg-slate-50">SKU</th>
                  <th className="px-4 py-2 bg-slate-50">Item</th>
                  <th className="px-4 py-2 bg-slate-50">Vendor</th>
                  <th className="px-4 py-2 bg-slate-50">Description</th>
                  <th className="px-4 py-2 bg-slate-50 text-right">Forecast</th>
                  <th className="px-4 py-2 bg-slate-50 text-right">In Stock</th>
                  <th className="px-4 py-2 bg-slate-50 text-right bg-blue-50 text-blue-800">Purchase</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(selectedSummary.items || [])
                  .filter(row => {
                    if (!modalSearch) return true;
                    const term = modalSearch.toLowerCase();
                    return (
                      (row.SKU || '').toLowerCase().includes(term) ||
                      (row.Item || '').toLowerCase().includes(term) ||
                      (row.Vendor || '').toLowerCase().includes(term) ||
                      (row.Description || '').toLowerCase().includes(term)
                    );
                  })
                  .map(row => (
                    <tr key={row.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2 font-mono text-xs text-slate-500">{row.SKU}</td>
                      <td className="px-4 py-2 font-medium">{row.Item}</td>
                      <td className="px-4 py-2 text-slate-500">{row.Vendor}</td>
                      <td className="px-4 py-2 text-slate-500 truncate max-w-xs">{row.Description}</td>
                      <td className="px-4 py-2 text-right font-mono">{row.Forecast}</td>
                      <td className="px-4 py-2 text-right font-mono text-slate-500">{row.InStock}</td>
                      <td className="px-4 py-2 text-right font-mono font-bold bg-blue-50 text-blue-800">{row.Purchase}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="px-6 py-4 border-t bg-slate-50 flex justify-end">
            <button
              onClick={() => setSelectedSummary(null)}
              className="px-4 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg shadow-sm"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    )}
  </div>
);
}

// --- Sub-Components ---

// --- UploadScreen Component ---


function UploadScreen({ onUpload, sales, inv, onLoadLocal }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-50 p-8 font-sans">
      <div className="bg-white p-8 rounded-xl shadow-lg max-w-2xl w-full border border-slate-200">
        <div className="text-center mb-8">
          <div className="bg-blue-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
            <Upload className="w-8 h-8 text-blue-600" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800">Inventory Dashboard Setup</h1>
          <p className="text-slate-500 mt-2">Upload your raw CSV files to generate the interactive shopping list.</p>
        </div>
        <div className="space-y-6">
          <UploadBox file={sales} type="sales" onUpload={onUpload} label="Kampstore Sales.csv" />
          <UploadBox file={inv} type="inventory" onUpload={onUpload} label="Inventory Count Log.csv" />

          <div className="relative flex py-2 items-center">
            <div className="flex-grow border-t border-slate-200"></div>
            <span className="flex-shrink mx-4 text-slate-400 text-sm">Or</span>
            <div className="flex-grow border-t border-slate-200"></div>
          </div>

          <button
            onClick={onLoadLocal}
            className="w-full py-3 bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 font-semibold rounded-lg shadow-sm transition-colors flex items-center justify-center gap-2"
          >
            <Download className="w-4 h-4" /> Load Local Data (public/data)
          </button>
        </div>
      </div>
    </div>
  );
}

function UploadBox({ file, type, onUpload, label }) {
  return (
    <div className={`p-6 border-2 border-dashed rounded-lg transition-colors ${file ? 'border-green-400 bg-green-50' : 'border-slate-300 hover:border-blue-400'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileText className={file ? "text-green-600" : "text-slate-400"} />
          <div>
            <p className="font-semibold text-slate-700">{label}</p>
            <p className="text-xs text-slate-500">{file ? `${file.length.toLocaleString()} rows loaded` : "Required"}</p>
          </div>
        </div>
        {!file && (
          <label className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md cursor-pointer text-sm font-medium transition-colors">
            Browse
            <input type="file" accept=".csv" className="hidden" onChange={(e) => onUpload(e, type)} />
          </label>
        )}
        {file && <Check className="text-green-600 w-6 h-6" />}
      </div>
    </div>
  );
}

function TabButton({ icon: Icon, label, active, onClick, count }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${active ? 'bg-slate-100 text-blue-700' : 'text-slate-600 hover:bg-slate-50'}`}
    >
      <Icon className="w-4 h-4" />
      {label}
      {count !== undefined && count > 0 && <span className="bg-blue-600 text-white text-[10px] px-1.5 py-0.5 rounded-full">{count}</span>}
    </button>
  );
}

function SortableHeader({ label, sortKey, currentSort, onSort, className }) {
  const isActive = currentSort.key === sortKey;
  return (
    <th className={`px-4 py-3 cursor-pointer group hover:bg-slate-100 transition-colors ${className}`} onClick={() => onSort(sortKey)}>
      <div className="flex items-center justify-end gap-1">
        {label}
        <ArrowUpDown className={`w-3 h-3 ${isActive ? 'text-blue-600' : 'text-slate-300 group-hover:text-slate-500'}`} />
      </div>
    </th>
  );
}

function TextFilterGroup({ label, includeVal, excludeVal, onIncludeChange, onExcludeChange }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-slate-700 uppercase tracking-wider">{label}</div>
      <div className="grid grid-cols-1 gap-2">
        <div className="relative">
          <PlusCircle className="absolute left-2 top-2 w-3.5 h-3.5 text-green-600" />
          <input type="text" placeholder="Include keywords..." className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-300 rounded focus:ring-1 focus:ring-green-500 outline-none" value={includeVal} onChange={e => onIncludeChange(e.target.value)} />
        </div>
        <div className="relative">
          <MinusCircle className="absolute left-2 top-2 w-3.5 h-3.5 text-red-500" />
          <input type="text" placeholder="Exclude keywords..." className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-300 rounded focus:ring-1 focus:ring-red-500 outline-none" value={excludeVal} onChange={e => onExcludeChange(e.target.value)} />
        </div>
      </div>
    </div>
  );
}

function NumericRangeFilter({ label, minVal, maxVal, onMinChange, onMaxChange }) {
  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-600">{label}</div>
      <div className="flex gap-2">
        <input type="number" placeholder="Min" className="w-1/2 px-2 py-1 text-xs border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 outline-none" value={minVal} onChange={(e) => onMinChange(e.target.value)} />
        <input type="number" placeholder="Max" className="w-1/2 px-2 py-1 text-xs border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 outline-none" value={maxVal} onChange={(e) => onMaxChange(e.target.value)} />
      </div>
    </div>
  );
}

function FilterSection({ title, options, selected, onToggle, searchable }) {
  const [isOpen, setIsOpen] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const displayOptions = options.filter(opt => !searchTerm || (opt || '').toLowerCase().includes(searchTerm.toLowerCase()));

  return (
    <div className="border-b pb-4 last:border-0">
      <button onClick={() => setIsOpen(!isOpen)} className="flex items-center justify-between w-full mb-2 font-medium text-slate-700 hover:text-blue-600 group">
        {title}
        <div className="flex items-center gap-1">
          {selected.length > 0 && <span className="bg-blue-100 text-blue-700 text-[10px] px-1.5 rounded-full font-bold">{selected.length}</span>}
          <span className="text-xs text-slate-400 group-hover:text-blue-500">{isOpen ? '−' : '+'}</span>
        </div>
      </button>
      {isOpen && (
        <>
          {searchable && (
            <div className="relative mb-2">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-2.5" />
              <input type="text" placeholder={`Search ${title}...`} className="w-full pl-7 pr-2 py-1.5 text-xs border rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 border-slate-300" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
            </div>
          )}
          <div className="space-y-1 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
            {displayOptions.map(opt => (
              <label key={opt} className="flex items-center gap-2 text-sm text-slate-600 hover:bg-slate-50 p-1 rounded cursor-pointer select-none">
                <input type="checkbox" checked={selected.includes(opt)} onChange={() => onToggle(opt)} className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5" />
                <span className="truncate">{opt || '(Blank)'}</span>
              </label>
            ))}
            {displayOptions.length === 0 && <span className="text-xs text-slate-400 italic px-1 block">{searchTerm ? 'No matches' : 'No options available'}</span>}
          </div>
        </>
      )}
    </div>
  );
}