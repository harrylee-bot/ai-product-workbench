ALTER TYPE "ProductDesignStateStatus" ADD VALUE IF NOT EXISTS 'intake';
ALTER TYPE "ProductDesignStateStatus" ADD VALUE IF NOT EXISTS 'format_check';
ALTER TYPE "ProductDesignStateStatus" ADD VALUE IF NOT EXISTS 'scoring';
ALTER TYPE "ProductDesignStateStatus" ADD VALUE IF NOT EXISTS 'optimizing';
ALTER TYPE "ProductDesignStateStatus" ADD VALUE IF NOT EXISTS 'doc_ready';
