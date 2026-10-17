BEGIN READ ONLY;
WITH tables AS (
 SELECT c.oid,c.relname,n.nspname,c.relrowsecurity,pg_catalog.obj_description(c.oid,'pg_class') AS comment
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='snapway' AND c.relkind IN ('r','p')
)
SELECT jsonb_build_object(
 'captured_at',current_timestamp,'database',current_database(),'role',current_user,
 'server_version',current_setting('server_version'),'schema','snapway',
 'transaction_read_only',current_setting('transaction_read_only'),
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',t.relname,'schema',t.nspname,'rls_enabled',t.relrowsecurity,'comment',t.comment,
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'position',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),'comment',pg_catalog.col_description(a.attrelid,a.attnum)) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped)
 ) ORDER BY t.relname) FROM tables t),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',k.conname,'kind',k.contype,'validated',k.convalidated,'deferrable',k.condeferrable,'initially_deferred',k.condeferred,
 'columns',(SELECT jsonb_agg(a.attname ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(attnum,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.attnum),
 'target_schema',rn.nspname,'target_table',rc.relname,
 'target_columns',(SELECT jsonb_agg(a.attname ORDER BY x.ord) FROM unnest(k.confkey) WITH ORDINALITY x(attnum,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.attnum),
 'definition',pg_catalog.pg_get_constraintdef(k.oid,true)
 ) ORDER BY t.relname,k.contype,k.conname) FROM tables t JOIN pg_catalog.pg_constraint k ON k.conrelid=t.oid LEFT JOIN pg_catalog.pg_class rc ON rc.oid=k.confrelid LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid=rc.relnamespace WHERE k.contype<>'n'),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',ic.relname,'unique',i.indisunique,'valid',i.indisvalid,'definition',pg_catalog.pg_get_indexdef(i.indexrelid)) ORDER BY t.relname,ic.relname) FROM tables t JOIN pg_catalog.pg_index i ON i.indrelid=t.oid JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',tr.tgname,'enabled',tr.tgenabled,'definition',pg_catalog.pg_get_triggerdef(tr.oid,true)) ORDER BY t.relname,tr.tgname) FROM tables t JOIN pg_catalog.pg_trigger tr ON tr.tgrelid=t.oid WHERE NOT tr.tgisinternal)
) AS snapshot;
COMMIT;
