"use client";

import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { formatNumber } from "@/lib/shared/formatters";

function computePageWindow(page: number, totalPages: number): number[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  if (page <= 3) return [1, 2, 3, 4, 5];
  if (page >= totalPages - 2) return [totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  return [page - 2, page - 1, page, page + 1, page + 2];
}

export function PagePagination({
  page,
  total,
  pageSize,
  disabled,
  label,
  onPageChange,
}: {
  page: number;
  total: number;
  pageSize: number;
  disabled?: boolean;
  label?: string;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageWindow = computePageWindow(page, totalPages);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-[var(--color-foreground-muted)]">
        {label ?? `共 ${formatNumber(total)} 条`}，第 {page} / {totalPages} 页
      </p>
      <Pagination className="mx-0 w-auto">
        <PaginationContent className="flex-wrap gap-1">
          <PaginationItem>
            <PaginationPrevious disabled={disabled || page <= 1} onClick={() => page > 1 && onPageChange(page - 1)} />
          </PaginationItem>

          {pageWindow[0] > 1 ? (
            <>
              <PaginationItem className="hidden sm:list-item">
                <PaginationLink disabled={disabled} onClick={() => onPageChange(1)} isActive={page === 1}>1</PaginationLink>
              </PaginationItem>
              {pageWindow[0] > 2 ? (
                <PaginationItem className="hidden sm:list-item">
                  <PaginationEllipsis />
                </PaginationItem>
              ) : null}
            </>
          ) : null}

          {pageWindow.map((pageNo) => (
            <PaginationItem key={pageNo} className="hidden sm:list-item">
              <PaginationLink disabled={disabled} isActive={pageNo === page} onClick={() => onPageChange(pageNo)}>
                {pageNo}
              </PaginationLink>
            </PaginationItem>
          ))}

          {pageWindow[pageWindow.length - 1] < totalPages ? (
            <>
              {pageWindow[pageWindow.length - 1] < totalPages - 1 ? (
                <PaginationItem className="hidden sm:list-item">
                  <PaginationEllipsis />
                </PaginationItem>
              ) : null}
              <PaginationItem className="hidden sm:list-item">
                <PaginationLink disabled={disabled} onClick={() => onPageChange(totalPages)} isActive={page === totalPages}>
                  {totalPages}
                </PaginationLink>
              </PaginationItem>
            </>
          ) : null}

          <PaginationItem>
            <PaginationNext disabled={disabled || page >= totalPages} onClick={() => page < totalPages && onPageChange(page + 1)} />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
