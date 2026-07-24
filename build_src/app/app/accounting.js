import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";

const API_URL = "https://market-cy.com/accounting/index.php";
const APP_KEY = "__APP_KEY__";
const COMPANY = "MASH TRADING & DISTRIBUTION LTD";
const VAT = "CY60300156R";

const STATUS_LABELS = {
  confirmed: "Επιβεβαιωμένο",
  review: "Έλεγχος",
  error: "Σφάλμα",
  unclassified: "Μη ταξινομημένο",
};

function money(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? `€${n.toFixed(2)}` : "€0.00";
}

function monthTitle(year, month) {
  return new Intl.DateTimeFormat("el-CY", { month: "long", year: "numeric" }).format(
    new Date(Number(year), Number(month) - 1, 1)
  );
}

async function api(action, options = {}) {
  const { method = "GET", params = {}, body = null } = options;
  const query = new URLSearchParams({ action, ...Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
  ) });
  const response = await fetch(`${API_URL}?${query.toString()}`, {
    method,
    headers: {
      Accept: "application/json",
      "X-App-Key": APP_KEY,
      ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text || "{}");
  } catch {
    throw new Error(`Μη έγκυρη απάντηση server (${response.status}).`);
  }
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.message || data?.error || `Σφάλμα λογιστηρίου (${response.status}).`);
  }
  return data;
}

function ActionButton({ icon, title, subtitle, onPress, busy, tone = "dark" }) {
  return (
    <Pressable
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [styles.action, styles[`action_${tone}`], pressed && styles.pressed, busy && styles.disabled]}
    >
      <View style={styles.actionIcon}><Ionicons name={icon} size={22} color="#fff" /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.actionTitle}>{title}</Text>
        <Text style={styles.actionSub}>{subtitle}</Text>
      </View>
      {busy ? <ActivityIndicator color="#fff" /> : <Ionicons name="chevron-forward" size={20} color="#fff" />}
    </Pressable>
  );
}

function StatusPill({ status }) {
  return (
    <View style={[styles.statusPill, styles[`status_${status}`] || styles.status_review]}>
      <Text style={styles.statusText}>{STATUS_LABELS[status] || status}</Text>
    </View>
  );
}

export default function AccountingScreen() {
  const router = useRouter();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [status, setStatus] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [invoices, setInvoices] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [serverInfo, setServerInfo] = useState(null);
  const [selected, setSelected] = useState(null);
  const [eventsOpen, setEventsOpen] = useState(false);

  const totals = useMemo(() => invoices.reduce((a, x) => {
    a.count += 1;
    a.total += Number(x.total_amount || 0);
    return a;
  }, { count: 0, total: 0 }), [invoices]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [health, list, supplierData, eventData] = await Promise.all([
        api("health"),
        api("list", { params: { year, month, status, supplier_id: supplierId } }),
        api("suppliers"),
        api("events", { params: { limit: 20 } }),
      ]);
      setServerInfo(health);
      setInvoices(Array.isArray(list.items) ? list.items : []);
      setSuppliers(Array.isArray(supplierData.items) ? supplierData.items : []);
      setEvents(Array.isArray(eventData.items) ? eventData.items : []);
    } catch (e) {
      Alert.alert("Λογιστήριο", e.message || String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [year, month, status, supplierId]);

  useEffect(() => { load(); }, [load]);

  function moveMonth(delta) {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  }

  async function uploadAssets(assets) {
    if (!assets?.length) return;
    setUploading(true);
    let ok = 0;
    const failures = [];
    try {
      for (let i = 0; i < assets.length; i += 1) {
        const asset = assets[i];
        const form = new FormData();
        const uri = asset.uri;
        const name = asset.name || asset.fileName || `invoice_${Date.now()}_${i + 1}.jpg`;
        const type = asset.mimeType || asset.type || (name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
        form.append("file", { uri, name, type });
        try {
          await api("upload", { method: "POST", body: form });
          ok += 1;
        } catch (e) {
          failures.push(`${name}: ${e.message}`);
        }
      }
      await load(true);
      Alert.alert(
        "Ολοκληρώθηκε",
        `${ok} αρχείο/αρχεία αποθηκεύτηκαν.${failures.length ? `\n\nΑποτυχίες:\n${failures.join("\n")}` : ""}`
      );
    } finally {
      setUploading(false);
    }
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return Alert.alert("Κάμερα", "Χρειάζεται άδεια κάμερας.");
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 1,
      allowsEditing: false,
      exif: false,
    });
    if (!result.canceled) await uploadAssets(result.assets);
  }

  async function pickPhotos() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
      allowsMultipleSelection: true,
      selectionLimit: 10,
    });
    if (!result.canceled) await uploadAssets(result.assets);
  }

  async function pickDocument() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "image/*"],
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (!result.canceled) await uploadAssets(result.assets);
  }

  async function retryInvoice(id) {
    try {
      await api("retry", { method: "POST", body: { id } });
      await load(true);
      Alert.alert("Έτοιμο", "Το τιμολόγιο αναλύθηκε ξανά.");
    } catch (e) {
      Alert.alert("Σφάλμα", e.message);
    }
  }

  function deleteInvoice(id) {
    Alert.alert("Διαγραφή", "Να διαγραφεί το τιμολόγιο από τη λίστα; Το αρχικό αρχείο παραμένει στο ασφαλές backup.", [
      { text: "Άκυρο", style: "cancel" },
      {
        text: "Διαγραφή", style: "destructive", onPress: async () => {
          try {
            await api("delete", { method: "POST", body: { id } });
            setSelected(null);
            await load(true);
          } catch (e) { Alert.alert("Σφάλμα", e.message); }
        },
      },
    ]);
  }

  async function openReport() {
    try {
      const data = await api("report_link", { method: "POST", body: { year, month, supplier_id: supplierId || null } });
      if (!data.url) throw new Error("Δεν δημιουργήθηκε σύνδεσμος αναφοράς.");
      await Linking.openURL(data.url);
    } catch (e) { Alert.alert("Αναφορά", e.message); }
  }

  function renderInvoice({ item }) {
    return (
      <Pressable onPress={() => setSelected({ ...item })} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
        <View style={styles.cardTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.supplier} numberOfLines={2}>{item.supplier_name || "Άγνωστος προμηθευτής"}</Text>
            <Text style={styles.meta}>{item.invoice_number || "Χωρίς αριθμό"} · {item.issue_date || "Χωρίς ημερομηνία"}</Text>
          </View>
          <StatusPill status={item.status} />
        </View>
        <View style={styles.amountRow}>
          <View><Text style={styles.amountLabel}>Καθαρή</Text><Text style={styles.amount}>{money(item.net_amount)}</Text></View>
          <View><Text style={styles.amountLabel}>ΦΠΑ</Text><Text style={styles.amount}>{money(item.vat_amount)}</Text></View>
          <View style={{ alignItems: "flex-end" }}><Text style={styles.amountLabel}>Σύνολο</Text><Text style={styles.total}>{money(item.total_amount)}</Text></View>
        </View>
        {!!item.review_reason && <Text style={styles.reason} numberOfLines={2}>{item.review_reason}</Text>}
      </Pressable>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn}><Ionicons name="arrow-back" size={22} color="#0f172a" /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Λογιστήριο Market-CY</Text>
          <Text style={styles.headerSub}>{COMPANY} · {VAT}</Text>
        </View>
        <Pressable onPress={() => setEventsOpen(true)} style={styles.iconBtn}><Ionicons name="list-outline" size={22} color="#0f172a" /></Pressable>
      </View>

      <FlatList
        data={invoices}
        keyExtractor={(x) => String(x.id)}
        renderItem={renderInvoice}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} />}
        contentContainerStyle={styles.content}
        ListHeaderComponent={(
          <View>
            <View style={styles.serverCard}>
              <View style={[styles.dot, { backgroundColor: serverInfo?.ok ? "#16a34a" : "#f59e0b" }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.serverTitle}>{serverInfo?.ok ? "Server συνδεδεμένος" : "Έλεγχος server"}</Text>
                <Text style={styles.serverSub}>{serverInfo?.version || "Market-CY Accounting"} · ξεχωριστή βάση</Text>
              </View>
              {loading && <ActivityIndicator />}
            </View>

            <ActionButton icon="camera-outline" title="Φωτογραφία τιμολογίου" subtitle="Λήψη με κάμερα και αυτόματη ανάλυση" onPress={takePhoto} busy={uploading} tone="blue" />
            <ActionButton icon="images-outline" title="Επιλογή φωτογραφιών" subtitle="Μία ή περισσότερες σελίδες" onPress={pickPhotos} busy={uploading} tone="purple" />
            <ActionButton icon="document-attach-outline" title="PDF ή αρχείο" subtitle="Εισαγωγή υπάρχοντος τιμολογίου" onPress={pickDocument} busy={uploading} tone="dark" />

            <View style={styles.monthRow}>
              <Pressable onPress={() => moveMonth(-1)} style={styles.smallBtn}><Ionicons name="chevron-back" size={20} color="#0f172a" /></Pressable>
              <View style={{ flex: 1, alignItems: "center" }}>
                <Text style={styles.monthTitle}>{monthTitle(year, month)}</Text>
                <Text style={styles.monthMeta}>{totals.count} τιμολόγια · {money(totals.total)}</Text>
              </View>
              <Pressable onPress={() => moveMonth(1)} style={styles.smallBtn}><Ionicons name="chevron-forward" size={20} color="#0f172a" /></Pressable>
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
              {["", "review", "confirmed", "error"].map((s) => (
                <Pressable key={s || "all"} onPress={() => setStatus(s)} style={[styles.filter, status === s && styles.filterOn]}>
                  <Text style={[styles.filterText, status === s && styles.filterTextOn]}>{s ? STATUS_LABELS[s] : "Όλα"}</Text>
                </Pressable>
              ))}
            </ScrollView>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
              <Pressable onPress={() => setSupplierId("")} style={[styles.filter, supplierId === "" && styles.filterOn]}>
                <Text style={[styles.filterText, supplierId === "" && styles.filterTextOn]}>Όλοι οι προμηθευτές</Text>
              </Pressable>
              {suppliers.map((s) => (
                <Pressable key={String(s.id)} onPress={() => setSupplierId(String(s.id))} style={[styles.filter, String(supplierId) === String(s.id) && styles.filterOn]}>
                  <Text numberOfLines={1} style={[styles.filterText, String(supplierId) === String(s.id) && styles.filterTextOn]}>{s.name}</Text>
                </Pressable>
              ))}
            </ScrollView>

            <Pressable onPress={openReport} style={styles.reportBtn}>
              <Ionicons name="folder-open-outline" size={20} color="#fff" />
              <Text style={styles.reportText}>Άνοιγμα φακέλου λογιστή / αναφοράς μήνα</Text>
            </Pressable>
            <Text style={styles.sectionTitle}>Τιμολόγια</Text>
          </View>
        )}
        ListEmptyComponent={!loading ? <Text style={styles.empty}>Δεν υπάρχουν τιμολόγια για τα επιλεγμένα φίλτρα.</Text> : null}
        ListFooterComponent={<View style={{ height: 30 }} />}
      />

      <InvoiceModal
        visible={!!selected}
        invoice={selected}
        suppliers={suppliers}
        onClose={() => setSelected(null)}
        onRetry={retryInvoice}
        onDelete={deleteInvoice}
        onSaved={async () => { setSelected(null); await load(true); }}
      />

      <Modal visible={eventsOpen} animationType="slide" onRequestClose={() => setEventsOpen(false)}>
        <SafeAreaView style={styles.screen}>
          <View style={styles.header}>
            <Pressable onPress={() => setEventsOpen(false)} style={styles.iconBtn}><Ionicons name="close" size={22} color="#0f172a" /></Pressable>
            <Text style={[styles.headerTitle, { flex: 1 }]}>Τελευταίες 20 ενέργειες</Text>
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            {events.map((e) => (
              <View key={String(e.id)} style={styles.eventCard}>
                <Text style={styles.eventTitle}>{e.action}</Text>
                <Text style={styles.eventMeta}>{e.created_at}</Text>
                {!!e.message && <Text style={styles.eventText}>{e.message}</Text>}
              </View>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function InvoiceModal({ visible, invoice, suppliers, onClose, onRetry, onDelete, onSaved }) {
  const [form, setForm] = useState(invoice || {});
  const [saving, setSaving] = useState(false);
  useEffect(() => { setForm(invoice || {}); }, [invoice]);
  if (!invoice) return null;

  const field = (key, label, keyboardType = "default") => (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={String(form?.[key] ?? "")}
        onChangeText={(v) => setForm((p) => ({ ...p, [key]: v }))}
        keyboardType={keyboardType}
        style={styles.input}
        placeholderTextColor="#94a3b8"
      />
    </View>
  );

  async function save() {
    setSaving(true);
    try {
      await api("update", {
        method: "POST",
        body: {
          id: invoice.id,
          supplier_id: form.supplier_id || null,
          invoice_number: form.invoice_number || "",
          issue_date: form.issue_date || "",
          net_amount: form.net_amount || 0,
          vat_amount: form.vat_amount || 0,
          total_amount: form.total_amount || 0,
          status: form.status || "review",
        },
      });
      await onSaved();
    } catch (e) { Alert.alert("Αποθήκευση", e.message); }
    finally { setSaving(false); }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <Pressable onPress={onClose} style={styles.iconBtn}><Ionicons name="close" size={22} color="#0f172a" /></Pressable>
          <View style={{ flex: 1 }}><Text style={styles.headerTitle}>Έλεγχος τιμολογίου</Text><Text style={styles.headerSub}>ID #{invoice.id}</Text></View>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.fieldLabel}>Προμηθευτής</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
            {suppliers.map((s) => (
              <Pressable key={String(s.id)} onPress={() => setForm((p) => ({ ...p, supplier_id: s.id, supplier_name: s.name }))} style={[styles.filter, String(form.supplier_id) === String(s.id) && styles.filterOn]}>
                <Text style={[styles.filterText, String(form.supplier_id) === String(s.id) && styles.filterTextOn]}>{s.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {field("invoice_number", "Αριθμός τιμολογίου")}
          {field("issue_date", "Ημερομηνία YYYY-MM-DD")}
          <View style={styles.twoCols}>{field("net_amount", "Καθαρή αξία", "decimal-pad")}{field("vat_amount", "ΦΠΑ", "decimal-pad")}</View>
          {field("total_amount", "Τελικό σύνολο", "decimal-pad")}
          <Text style={styles.fieldLabel}>Κατάσταση</Text>
          <View style={styles.filters}>
            {["review", "confirmed", "error", "unclassified"].map((s) => (
              <Pressable key={s} onPress={() => setForm((p) => ({ ...p, status: s }))} style={[styles.filter, form.status === s && styles.filterOn]}>
                <Text style={[styles.filterText, form.status === s && styles.filterTextOn]}>{STATUS_LABELS[s]}</Text>
              </Pressable>
            ))}
          </View>
          {!!invoice.review_reason && <View style={styles.warning}><Text style={styles.warningTitle}>Χρειάζεται έλεγχο</Text><Text style={styles.warningText}>{invoice.review_reason}</Text></View>}
          <Pressable disabled={saving} onPress={save} style={styles.saveBtn}>{saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Αποθήκευση</Text>}</Pressable>
          <View style={styles.twoCols}>
            <Pressable onPress={() => onRetry(invoice.id)} style={styles.secondaryBtn}><Text style={styles.secondaryText}>Νέα ανάλυση AI</Text></Pressable>
            <Pressable onPress={() => onDelete(invoice.id)} style={styles.deleteBtn}><Text style={styles.deleteText}>Διαγραφή</Text></Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f4f7fb" },
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: "#fff", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#e2e8f0" },
  headerTitle: { color: "#0f172a", fontSize: 18, fontWeight: "900" },
  headerSub: { color: "#64748b", fontSize: 11.5, fontWeight: "700", marginTop: 2 },
  iconBtn: { width: 42, height: 42, borderRadius: 14, backgroundColor: "#f1f5f9", alignItems: "center", justifyContent: "center" },
  content: { padding: 14 },
  serverCard: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#fff", borderRadius: 18, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: "#e2e8f0" },
  dot: { width: 10, height: 10, borderRadius: 5 },
  serverTitle: { color: "#0f172a", fontWeight: "900", fontSize: 14 },
  serverSub: { color: "#64748b", fontWeight: "600", fontSize: 11.5, marginTop: 2 },
  action: { minHeight: 76, borderRadius: 20, paddingHorizontal: 14, marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 12 },
  action_dark: { backgroundColor: "#0f172a" },
  action_blue: { backgroundColor: "#2563eb" },
  action_purple: { backgroundColor: "#7c3aed" },
  actionIcon: { width: 44, height: 44, borderRadius: 15, backgroundColor: "rgba(255,255,255,0.14)", alignItems: "center", justifyContent: "center" },
  actionTitle: { color: "#fff", fontSize: 15, fontWeight: "900" },
  actionSub: { color: "rgba(255,255,255,0.72)", fontSize: 11.5, fontWeight: "600", marginTop: 3 },
  pressed: { opacity: 0.88, transform: [{ scale: 0.992 }] },
  disabled: { opacity: 0.58 },
  monthRow: { flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderRadius: 18, padding: 10, marginTop: 4, borderWidth: 1, borderColor: "#e2e8f0" },
  smallBtn: { width: 40, height: 40, borderRadius: 13, backgroundColor: "#f1f5f9", alignItems: "center", justifyContent: "center" },
  monthTitle: { color: "#0f172a", fontSize: 16, fontWeight: "900", textTransform: "capitalize" },
  monthMeta: { color: "#64748b", fontSize: 11.5, fontWeight: "700", marginTop: 2 },
  filters: { flexDirection: "row", gap: 8, paddingVertical: 10 },
  filter: { maxWidth: 220, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 999, backgroundColor: "#fff", borderWidth: 1, borderColor: "#e2e8f0" },
  filterOn: { backgroundColor: "#0f172a", borderColor: "#0f172a" },
  filterText: { color: "#475569", fontSize: 11.5, fontWeight: "800" },
  filterTextOn: { color: "#fff" },
  reportBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#16a34a", borderRadius: 16, paddingVertical: 13, marginBottom: 14 },
  reportText: { color: "#fff", fontWeight: "900", fontSize: 12.5 },
  sectionTitle: { color: "#0f172a", fontSize: 17, fontWeight: "900", marginBottom: 8 },
  card: { backgroundColor: "#fff", borderRadius: 18, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: "#e2e8f0", shadowColor: "#0f172a", shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.05, shadowRadius: 10, elevation: 2 },
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  supplier: { color: "#0f172a", fontSize: 14.5, lineHeight: 19, fontWeight: "900" },
  meta: { color: "#64748b", fontSize: 11.5, fontWeight: "700", marginTop: 4 },
  statusPill: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 999 },
  status_confirmed: { backgroundColor: "#dcfce7" },
  status_review: { backgroundColor: "#fef3c7" },
  status_error: { backgroundColor: "#fee2e2" },
  status_unclassified: { backgroundColor: "#e2e8f0" },
  statusText: { color: "#334155", fontWeight: "900", fontSize: 9.5 },
  amountRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#e2e8f0" },
  amountLabel: { color: "#94a3b8", fontSize: 9.5, fontWeight: "900", textTransform: "uppercase" },
  amount: { color: "#334155", fontSize: 13.5, fontWeight: "900", marginTop: 3 },
  total: { color: "#0f172a", fontSize: 17, fontWeight: "900", marginTop: 3 },
  reason: { color: "#b45309", fontSize: 11, lineHeight: 16, fontWeight: "700", marginTop: 10 },
  empty: { color: "#64748b", textAlign: "center", paddingVertical: 32, fontWeight: "700" },
  fieldWrap: { flex: 1, marginBottom: 12 },
  fieldLabel: { color: "#334155", fontSize: 11.5, fontWeight: "900", marginBottom: 6 },
  input: { minHeight: 48, borderRadius: 14, backgroundColor: "#fff", borderWidth: 1, borderColor: "#cbd5e1", paddingHorizontal: 12, color: "#0f172a", fontSize: 14, fontWeight: "700" },
  twoCols: { flexDirection: "row", gap: 10 },
  warning: { backgroundColor: "#fffbeb", borderWidth: 1, borderColor: "#fde68a", borderRadius: 15, padding: 12, marginVertical: 10 },
  warningTitle: { color: "#92400e", fontWeight: "900", marginBottom: 4 },
  warningText: { color: "#b45309", fontSize: 12, lineHeight: 18, fontWeight: "700" },
  saveBtn: { minHeight: 52, backgroundColor: "#0f172a", borderRadius: 16, alignItems: "center", justifyContent: "center", marginVertical: 10 },
  saveText: { color: "#fff", fontWeight: "900", fontSize: 14 },
  secondaryBtn: { flex: 1, minHeight: 48, borderRadius: 15, backgroundColor: "#dbeafe", alignItems: "center", justifyContent: "center" },
  secondaryText: { color: "#1d4ed8", fontWeight: "900", fontSize: 12 },
  deleteBtn: { flex: 1, minHeight: 48, borderRadius: 15, backgroundColor: "#fee2e2", alignItems: "center", justifyContent: "center" },
  deleteText: { color: "#b91c1c", fontWeight: "900", fontSize: 12 },
  eventCard: { backgroundColor: "#fff", borderRadius: 15, padding: 12, marginBottom: 9, borderWidth: 1, borderColor: "#e2e8f0" },
  eventTitle: { color: "#0f172a", fontWeight: "900" },
  eventMeta: { color: "#94a3b8", fontSize: 10.5, fontWeight: "700", marginTop: 3 },
  eventText: { color: "#475569", fontSize: 12, lineHeight: 17, marginTop: 6 },
});
