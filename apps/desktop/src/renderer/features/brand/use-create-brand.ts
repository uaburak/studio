// New brand: validate, create, make it the current brand and open its profile (kit first).
import { useState } from "react";
import { describeError } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { useBrandActions } from "./brand-data.ts";
import { newBrandInput } from "./brand-model.ts";

export function useCreateBrandFlow() {
  const actions = useBrandActions();
  const setCurrentBrand = useAppStore((s) => s.setCurrentBrand);
  const navigate = useAppStore((s) => s.navigate);
  const showToast = useAppStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (name: string, slug: string, language: string): Promise<boolean> => {
    const input = newBrandInput(name, slug, language);
    if (!input.ok) {
      setError(input.reason);
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      const brand = await actions.create(input.input);
      setCurrentBrand(brand.id);
      navigate({ kind: "brand", id: brand.id });
      showToast({
        message: `${brand.name} oluşturuldu. Marka kitini doldurup AI ile analiz edebilirsin.`,
      });
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { create, busy, error };
}
