"use client";
import {useMemo} from "react";
import {stockForecastRows,STOCK_FORECAST_VERSION,type StockForecastRow} from "../stock-forecast";
import {useStockBoundaryClock} from "./use-stock-now";
export function useStockForecast(rows:StockForecastRow[]|undefined){
 const inputs=useMemo(()=>rows?.map(r=>r.forecastInput),[rows]);
 const at=useStockBoundaryClock(inputs);
 return useMemo(()=>rows?stockForecastRows({stockWindowVersion:STOCK_FORECAST_VERSION,horizonEnd:rows[0]?.horizonEnd??at,inputs:inputs??[]},at):undefined,[rows,inputs,at]);
}
