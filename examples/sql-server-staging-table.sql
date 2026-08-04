CREATE TABLE [staging].[PayrollImport]
(
    [LoadId] nvarchar(100) NOT NULL,
    [SourceRow] int NOT NULL,
    [Status] varchar(20) NOT NULL,
    [SourceType] varchar(30) NULL,
    [Category] varchar(30) NULL,
    [CompletionDate] datetime2(0) NULL,
    CONSTRAINT [PK_PayrollImport] PRIMARY KEY CLUSTERED ([LoadId], [SourceRow])
);
