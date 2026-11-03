import { useEffect, useRef, useState } from 'react'

/** Whether a drop-down menu is open; it closes when the pointer goes down outside `menuRef`. */
export function useDropdown() {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const closeOutside = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])
  return { open, setOpen, menuRef }
}
